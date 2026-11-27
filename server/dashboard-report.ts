import type { ActivityReport, AppsReport, BotReport, DevicesReport, MachineReport, PlansReport, WorkspaceReport } from "../shared/dashboard-protocol.ts";
import { cronScheduleLabel } from "../shared/cron-label.ts";
import type { Routine } from "../shared/routines.ts";
import type { PlanUsageReport } from "./plan-usage.ts";
import { serverVersion } from "./environment.ts";
import { hostname } from "node:os";
import { vpsSshAlias } from "./config.ts";
import type { AppConfig } from "./config.ts";
import type { ContainerRuntimeStatus } from "./container-computer.ts";
import { bounded, cachedSample, parseDockerStats, sampleMachine } from "./dashboard-machine.ts";
import type { DockerStats } from "./dashboard-machine.ts";
import type { LocalVmInventoryEntry } from "./local-vm-inventory.ts";
import type { PublicPhone } from "./phones/registry.ts";
import { billableFor } from "./prices.ts";
import type { PriceList } from "./prices.ts";
import type { PublicSession } from "./sessions.ts";
import type { BotRecord } from "./store.ts";
import { teamComputerOwner } from "./team-computers.ts";
import type { TeamComputerRecord } from "./team-computers.ts";
import type { UpdateCheck } from "./update-check.ts";
import { flushUsageLedger, readUsage } from "./usage-ledger.ts";
import type { UsageRow } from "./usage-ledger.ts";
import type * as vps from "./vps-computer.ts";
import { vpsAliasesInPlay } from "./vps-hosts.ts";

interface MobileState {
  devices: Array<{ id: string; sessionId: string; name: string; platform: string; createdAt: number }>;
  agent: { base: string; origin: string | null; seenAt: number } | null;
}

export interface DashboardCollectorDeps {
  dataDir: string;
  environmentId?: string;
  cfg: AppConfig;
  bots(): readonly Pick<BotRecord, "id" | "name" | "computer" | "vpsAlias" | "color" | "mascotBody" | "modelSelection">[];
  managedVpsOwners(): vps.ManagedVpsOwner[];
  teamComputers(): Pick<TeamComputerRecord, "id" | "name">[];
  localInventory(): Promise<{ instances: LocalVmInventoryEntry[] }>;
  localRuntime(): Promise<ContainerRuntimeStatus>;
  vps: Pick<typeof vps, "listManagedVpsComputers" | "vpsDockerArgs" | "defaultRunner" | "vpsContainerName">;
  lastUsedAt(botId: string): number | null;
  phones(): PublicPhone[];
  sessions(): PublicSession[];
  mobile(): MobileState;
  publicUrl(): string | null;
  deviceLabel(): string;
  checkUpdate(): Promise<UpdateCheck>;
  prices(): PriceList | null;
  computerKind?(botId: string): BotReport["computer"] | undefined;
  busy(botId: string): boolean;
  engine(instanceId: string): { displayName?: string; driverKind: string } | undefined;
  routines(): Array<Pick<Routine, "id" | "botId" | "name" | "schedule" | "enabled" | "nextRunAt"> & { scheduleLabel?: string; lastRunAt: number | null; running?: boolean }>;
  planUsage(): Promise<PlanUsageReport>;
  apps?(): Promise<AppsReport | null>;
  workspaceKind?: WorkspaceReport["workspace"]["kind"];
  machine?: typeof sampleMachine;
  usage?: { flush: typeof flushUsageLedger; read: typeof readUsage };
}

interface Service { id: string; name: string; state: "running" | "stopped" | "unknown"; detail: string | null }
interface Computer extends DockerStats {
  id: string; botId: string | null; botName: string | null;
  kind: "vps" | "local-vm" | "team"; name: string;
  state: "running" | "asleep" | "starting" | "missing" | "unknown";
  lastUsedAt: number | null; alias: string | null;
}
const noStats: DockerStats = { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null };
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function linkState(deps: DashboardCollectorDeps) {
  const agent = deps.mobile().agent, direct = deps.publicUrl();
  if (!agent && !direct) return null;
  const live = agent !== null && Date.now() - agent.seenAt < 40_000;
  return {
    mode: live ? "relay" as const : direct ? "direct" as const : "off" as const,
    connected: live || Boolean(direct), url: live ? agent.origin ?? agent.base : direct,
    since: null, detail: live ? "Link agent connected" : direct ? "Public server address configured" : "Link agent offline",
  };
}

export function createDashboardCollector(deps: DashboardCollectorDeps) {
  const aliases = () => vpsAliasesInPlay(deps.cfg, deps.bots());
  const localConfigured = () => Boolean(deps.cfg.localVm) || deps.bots().some((bot) => bot.computer === "vm");
  const provider = () => aliases().length ? "vps" as const : localConfigured() ? "local" as const : "none" as const;
  async function runDocker(alias: string, args: string[], timeoutMs: number) {
    const controller = new AbortController();
    try {
      return await bounded(() => deps.vps.defaultRunner(deps.vps.vpsDockerArgs(alias, args), { timeoutMs, signal: controller.signal }), timeoutMs, null);
    } finally { controller.abort(); }
  }
  const update = cachedSample(async () => {
    const result = await deps.checkUpdate();
    return { available: result.available, latest: result.latest ?? null, how: result.command ?? result.install ?? null };
  }, 10 * 60_000, 3000, null);
  const probes = new Map<string, () => Promise<Service>>();
  const dockerService = () => {
    const hosts = aliases(), key = hosts.length ? hosts.join(",") : provider();
    if (!probes.has(key)) probes.set(key, cachedSample(async (): Promise<Service> => {
      if (hosts.length) {
        const results = await Promise.all(hosts.map((alias) => runDocker(alias, ["info", "--format", "{{.ServerVersion}}"], 2900)));
        return { id: "docker", name: "Docker", state: results.every(Boolean) ? "running" : "stopped", detail: null };
      }
      if (localConfigured()) {
        const runtime = await deps.localRuntime();
        return { id: "docker", name: "Docker", state: runtime.daemonUp ? "running" : "stopped", detail: runtime.runtime };
      }
      return { id: "docker", name: "Docker", state: "unknown", detail: null };
    }, 30_000, 3000, { id: "docker", name: "Docker", state: "unknown", detail: null }));
    return probes.get(key)!();
  };
  const inventories = new Map<string, () => Promise<vps.ManagedVpsInventory | null>>();
  const stats = new Map<string, () => Promise<Map<string, DockerStats>>>();
  const local = cachedSample(() => deps.localInventory(), 5000, 5000, { instances: [] });
  const inventory = (alias: string) => {
    if (!inventories.has(alias)) inventories.set(alias, cachedSample(async () => {
      const controller = new AbortController();
      try {
        return await bounded(() => deps.vps.listManagedVpsComputers(deps.cfg, deps.managedVpsOwners(),
          (args, options) => deps.vps.defaultRunner(args, { ...options, timeoutMs: 4800, signal: controller.signal }), [alias]), 4900, null);
      } finally { controller.abort(); }
    }, 5000, 5000, null));
    return inventories.get(alias)!();
  };
  const dockerStats = (alias: string) => {
    if (!stats.has(alias)) stats.set(alias, cachedSample(async () => {
      const result = await runDocker(alias, ["stats", "--no-stream", "--format", "{{json .}}"], 5000);
      return parseDockerStats(result?.stdout ?? "");
    }, 5000, 5000, new Map()));
    return stats.get(alias)!();
  };

  async function computers(): Promise<WorkspaceReport["computers"]> {
    const hosts = aliases(), result: Computer[] = [], teams = deps.teamComputers();
    const makeVps = (ownerId: string | null, name: string, alias: string, state: Computer["state"], values = noStats): Computer => {
      const team = teams.find((entry) => teamComputerOwner(entry.id) === ownerId);
      const bot = deps.bots().find((entry) => entry.id === ownerId);
      return { id: `${alias}/${name}`, botId: bot?.id ?? null, botName: bot?.name ?? null, kind: team ? "team" : "vps",
        name: team?.name ?? bot?.name ?? name, state, ...values, lastUsedAt: bot ? deps.lastUsedAt(bot.id) : null, alias };
    };
    const work = [Promise.all(hosts.map(async (alias) => {
      const [found, sampled] = await Promise.all([inventory(alias), dockerStats(alias)]);
      const rows = (found?.instances ?? []).map((entry) => makeVps(entry.ownerBotId, entry.name, alias,
        entry.state === "running" ? "running" : entry.state === "created" || entry.state === "restarting" ? "starting"
          : entry.state === "paused" || entry.state === "exited" || entry.state === "dead" ? "asleep" : "unknown",
        entry.state === "running" ? sampled.get(entry.name) ?? noStats : noStats));
      const expected = [
        ...deps.bots().filter((bot) => bot.computer === "cloud" && (deps.cfg.vps?.mode === "per-bot" || bot.vpsAlias) && (bot.vpsAlias || vpsSshAlias(deps.cfg)) === alias).map((bot) => bot.id),
        ...(vpsSshAlias(deps.cfg) === alias ? teams.map((team) => teamComputerOwner(team.id)) : []),
      ];
      for (const ownerId of expected) {
        const name = deps.vps.vpsContainerName(ownerId);
        if (!found?.instances.some((entry) => entry.ownerBotId === ownerId)) rows.push(makeVps(ownerId, name, alias, found?.available ? "missing" : "unknown"));
      }
      result.push(...rows);
    })), localConfigured() ? local().then((found) => {
      result.push(...found.instances.map((entry): Computer => ({ id: `local/${entry.botId}`, botId: entry.botId,
        botName: entry.name, kind: "local-vm", name: entry.name, state: entry.container === "running" ? "running" : "asleep",
        ...noStats, lastUsedAt: deps.lastUsedAt(entry.botId), alias: null })));
    }) : Promise.resolve()];
    await bounded(() => Promise.all(work), 5500, []);
    if (!hosts.length) result.push(...teams.map((team): Computer => ({ id: `team/${team.id}`, botId: null, botName: null,
      kind: "team", name: team.name, state: "unknown", ...noStats, lastUsedAt: null, alias: null })));
    return { provider: provider(), computers: [...result].sort((a, b) => a.id.localeCompare(b.id)) };
  }

  async function machine(): Promise<MachineReport> {
    const [sample, availableUpdate, docker] = await Promise.all([(deps.machine ?? sampleMachine)(deps.dataDir), update(), dockerService()]);
    const services: Service[] = [{ id: "server", name: "Server", state: "running", detail: null }, docker];
    const link = linkState(deps);
    if (link) services.push({ id: "link", name: "Link", state: link.connected ? "running" : "stopped", detail: link.detail });
    const { host, cpu, memory, network, uptimeSec, processUptimeSec, app } = sample;
    return { host, cpu, memory, network, uptimeSec, processUptimeSec, app,
      disk: sample.disk ? { usedBytes: sample.disk.usedBytes, totalBytes: sample.disk.totalBytes, path: "" } : null,
      update: availableUpdate ? { ...availableUpdate, how: null } : null, services };
  }
  async function devices(): Promise<DevicesReport> {
    const sessions = deps.sessions(), mobile = deps.mobile();
    return {
      thisDevice: { label: deps.deviceLabel() || hostname(), kind: process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : "server" },
      link: linkState(deps),
      phones: [
        ...deps.phones().map((phone) => ({ id: `phone:${phone.key}`, label: phone.registration.name, platform: phone.registration.platform,
          pairedAt: phone.registeredAt, lastSeenAt: phone.seen })),
        ...mobile.devices.flatMap((device) => {
          const session = sessions.find((one) => one.id === device.sessionId);
          return session ? [{ id: `mobile:${device.id}`, label: device.name, platform: device.platform, pairedAt: device.createdAt,
            lastSeenAt: session.lastSeenAt }] : [];
        }),
      ],
      sessions: sessions.map(({ id, label, createdAt, lastSeenAt, scopes }) => ({ id, label, createdAt, lastSeenAt, scopes })),
    };
  }
  const collectActivity = cachedSample(async (): Promise<ActivityReport> => {
    const to = new Date(), from = new Date(to.getFullYear(), to.getMonth(), to.getDate());
    from.setDate(from.getDate() - 364);
    const ledger = deps.usage ?? { flush: flushUsageLedger, read: readUsage };
    await ledger.flush(deps.dataDir);
    return activity(ledger.read(deps.dataDir, { from, to }), deps.prices(), dateKey(from), dateKey(to));
  }, 60_000, 15_000, activity([], null, "", ""));
  const plans = cachedSample(async (): Promise<PlansReport | null> => {
    const report = await deps.planUsage();
    return { providers: report.providers.map((row) => ({ id: row.id, name: row.name, plan: row.plan, ok: row.ok,
      windows: [
        ...([["5-hour", row.fiveHour], ["Weekly", row.weekly]] as const).flatMap(([label, window]) => window.available && window.usedPercent !== null
          ? [{ label, usedPercent: window.usedPercent, resetsAt: resetTime(window.resetsAt) }] : []),
        ...row.extra.map((window) => ({ label: window.label, usedPercent: window.usedPercent, resetsAt: resetTime(window.resetsAt) })),
      ] })) };
  }, 300_000, 30_000, null);
  function bots(): BotReport[] {
    const routines = deps.routines();
    return deps.bots().map((bot) => {
      const engine = deps.engine(bot.modelSelection.instanceId);
      return { id: bot.id, name: bot.name, color: bot.color, body: bot.mascotBody ?? null, model: bot.modelSelection.model || null,
        engine: engine?.displayName || engine?.driverKind || null,
        computer: deps.computerKind?.(bot.id) ?? (bot.computer === "vm" ? "local-vm" : bot.computer === "cloud" ? "vps" : null),
        busy: deps.busy(bot.id), lastActiveAt: deps.lastUsedAt(bot.id),
        routines: routines.filter((routine) => routine.botId === bot.id).map((routine) => ({ id: routine.id, name: routine.name,
          schedule: routine.scheduleLabel || (routine.schedule.type === "cron" ? cronScheduleLabel(routine.schedule) : JSON.stringify(routine.schedule)),
          paused: !routine.enabled, nextRunAt: routine.nextRunAt, lastRunAt: routine.lastRunAt, running: routine.running === true })),
      };
    });
  }
  function workspace(): WorkspaceReport["workspace"] {
    return { name: deps.deviceLabel() || hostname(), kind: deps.workspaceKind ?? (process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux"), version: serverVersion(), platform: process.platform, ...(deps.environmentId ? { environmentId: deps.environmentId } : {}) };
  }
  const apps = () => deps.apps ? bounded(() => deps.apps!(), 20_000, null) : Promise.resolve(null);
  return { machine, computers, devices, activity: collectActivity, bots, plans, workspace, apps };
}

function resetTime(value: string | null): number | null {
  const time = value === null ? NaN : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function activity(rows: UsageRow[], prices: PriceList | null, from: string, to: string): ActivityReport {
  type Count = { turns: number; tokens: number; costUsd: number | null; input: number; output: number; cacheRead: number; cacheWrite: number };
  const empty = (): Count => ({ turns: 0, tokens: 0, costUsd: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const count = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  const days = new Map<string, Count>(), byBot = new Map<string, Count & { botId: string; botName: string; model: string | null }>();
  const byModel = new Map<string, Count & { model: string }>(), totals = empty();
  const add = (into: Count, row: UsageRow) => {
    into.turns++;
    // the ledger's input already holds the cache reads and writes
    const input = Math.max(0, row.input), output = Math.max(0, row.output);
    const cacheRead = Math.min(count(row.cachedInput), input), cacheWrite = Math.min(count(row.cacheWrite), input - cacheRead);
    into.tokens += input + output;
    into.input += input - cacheRead - cacheWrite;
    into.output += output;
    into.cacheRead += cacheRead;
    into.cacheWrite += cacheWrite;
    const cost = (prices ? billableFor(row, prices) : null) ?? row.costUsd;
    if (cost !== null) into.costUsd = (into.costUsd ?? 0) + cost;
  };
  for (const row of rows) {
    const day = dateKey(new Date(row.at));
    if (!days.has(day)) days.set(day, empty());
    if (!byBot.has(row.botId)) byBot.set(row.botId, { ...empty(), botId: row.botId, botName: row.botName || row.botId, model: row.model });
    else if (byBot.get(row.botId)!.model !== row.model) byBot.get(row.botId)!.model = null;
    if (!byModel.has(row.model)) byModel.set(row.model, { ...empty(), model: row.model });
    for (const count of [days.get(day)!, byBot.get(row.botId)!, byModel.get(row.model)!, totals]) add(count, row);
  }
  return { from, to, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, ...count })),
    byBot: [...byBot.values()], byModel: [...byModel.values()], totals };
}
