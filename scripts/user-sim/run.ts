// People getting real work done with dusk bot. Each scenario gets its own dusk bot server from --repo (an isolated data
// folder, the bot engine on --model through the gateway), a person's world in stateful connected apps (connectors.mjs
// as MCP servers) and home folder, a shifted wall clock (clock.mjs) so days pass in minutes, and a simulated person
// (person.ts) who talks to the bot over several conversations and days. Afterwards, ground-truth checks (checks.ts) and
// a judge (judge.ts) grade it; summary.ts writes summary.json and summary.md.
//   node --experimental-strip-types scripts/user-sim/run.ts --out <dir> [--only id,id] [--tag memory,routine]
//     [--parallel 4] [--repeat 1] [--model gpt-6.2-sol] [--judge gpt-6.2-sol] [--person gpt-6.2-sol] [--keep] [--repo <checkout>]
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { client } from "../memory-eval/client.ts";
import { gatewayFromEnv } from "../memory-eval/sandbox.ts";
import { launchServer, type StressServer } from "../stress-eval/server.ts";
import { proactiveMessages, runCheck, SETUP_DONE, type ChatRecord, type Evidence, type Msg } from "./checks.ts";
import { judge } from "./judge.ts";
import { DONE, personReply } from "./person.ts";
import { loadScenarios, validate, validateWorld, type Scenario, type Step } from "./scenario.ts";
import { writeSummary } from "./summary.ts";
import { connectorState, deepMerge, loadWorld, relEpoch, resolveTimes, setContentDir, startEpoch, type World } from "./world.ts";

const here = dirname(fileURLToPath(import.meta.url));
const git = (...args: string[]) => { try { return execFileSync("git", ["-C", values.repo!, ...args], { encoding: "utf8" }).trim().slice(0, 120); } catch { return undefined; } };
const { values } = parseArgs({ options: {
  repo: { type: "string", default: resolve(here, "..", "..") },
  out: { type: "string" },
  only: { type: "string", default: "" },
  tag: { type: "string", default: "" },
  parallel: { type: "string", default: "4" },
  repeat: { type: "string", default: "1" },
  model: { type: "string", default: "gpt-6.2-sol" },
  judge: { type: "string", default: "gpt-6.2-sol" },
  person: { type: "string", default: "gpt-6.2-sol" },
  "price-in": { type: "string", default: "1.25" },
  "price-out": { type: "string", default: "10" },
  keep: { type: "boolean", default: false },
  label: { type: "string", default: "" },
  content: { type: "string", default: "" },
  engine: { type: "string", default: "openai-compat" },
} });
if (values.content) setContentDir(resolve(values.content));
if (!values.out) throw new Error("--out is required (keep it outside the repo: results hold transcripts)");
const out = resolve(values.out);
mkdirSync(join(out, "transcripts"), { recursive: true });
const resultsPath = join(out, "results.jsonl");
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gateway = gatewayFromEnv(values.model!);
const personGateway = gatewayFromEnv(values.person!);
const judgeGateway = gatewayFromEnv(values.judge!);
const TURN_TIMEOUT_MS = 10 * 60_000;
const CAPTURE_QUIET_MS = 45_000;
const MAX_ROUTINE_STOPS = 8;
const AUTOMATION_PROMPT = /^\[(?:Scheduled routine|Routine|Webhook|App event)\b/;

type ApiMsg = { id: string; at: number; role: string; kind?: string; text?: string; quietRun?: boolean; card?: any; turnSucceeded?: boolean; digest?: { durationMs?: number; toolCalls?: number; usage?: { input?: number; output?: number; costUsd?: number | null } } };

interface TurnMetric { latencyMs: number; ttftMs: number | null; state: string }

/** First bot text per conversation, from the server's event stream, as the app would paint it. */
function watchFirstText(url: string) {
  const pending = new Map<string, { since: number; at: number | null }>();
  const abort = new AbortController();
  void (async () => {
    try {
      const res = await fetch(`${url}/api/events`, { headers: { origin: url, accept: "text/event-stream" }, signal: abort.signal });
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        const now = Date.now();
        for (const frame of frames) {
          if (!frame.includes('"role":"bot"') || !/"kind":"text"/.test(frame)) continue;
          for (const [threadId, wait] of pending) if (wait.at === null && frame.includes(threadId)) wait.at = now;
        }
      }
    } catch { /* closed with the server */ }
  })();
  return {
    arm: (threadId: string) => pending.set(threadId, { since: Date.now(), at: null }),
    read: (threadId: string) => { const w = pending.get(threadId); return w?.at ? w.at - w.since : null; },
    close: () => abort.abort(),
  };
}

const TERMINAL = ["needs-input", "completed", "failed", "stalled", "idle"];
async function waitIdle(api: ReturnType<typeof client>, threadId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  await sleep(800);
  let quiet = 0;
  for (;;) {
    const job = await api.call("GET", `/api/threads/${threadId}/job?scope=turn`).catch(() => ({ state: "unreachable" }));
    if (TERMINAL.includes(job.state)) { if (++quiet >= 3) return job.state; } else quiet = 0;
    if (Date.now() > deadline) return `timeout(${job.state})`;
    await sleep(700);
  }
}

function render(messages: ApiMsg[], names: { user: string; bot: string }): string {
  return messages.filter((m) => (m.role === "user" || m.role === "bot") && m.kind !== "digest" && m.kind !== "activity").map((m) => {
    const card = m.card ? ` [card: ${String(m.card.title ?? "")}${m.card.options?.length ? ` options: ${m.card.options.map((o: any) => o.label ?? o).join(" / ")}` : ""}]` : "";
    return `${m.role === "user" ? names.user : names.bot}: ${(m.text ?? "").slice(0, 2_500)}${card}`;
  }).join("\n\n");
}

const live = new Set<StressServer>();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log(`${signal}: stopping ${live.size} servers`);
    void Promise.all([...live].map((srv) => srv.close(values.keep))).finally(() => process.exit(130));
  });
}

async function runScenario(s: Scenario, run: number): Promise<Record<string, unknown>> {
  const world: World = deepMerge(loadWorld(s.world), s.seed ?? {});
  const tz = world.persona.tz;
  const first = world.persona.name.split(" ")[0]!.toLowerCase();
  mkdirSync(join(tmpdir(), "homes"), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "homes", `${first}-`));
  const lib = join(root, "lib");
  mkdirSync(lib);
  const clockJs = join(lib, "tz.mjs");
  const appsJs = join(lib, "apps.mjs");
  copyFileSync(join(here, "clock.mjs"), clockJs);
  copyFileSync(join(here, "connectors.mjs"), appsJs);
  const shiftFile = join(root, "tz-shift");
  const statePath = join(root, "accounts.json");
  const start = startEpoch(s.start ?? world.start, tz);
  let offset = start - Date.now();
  const setClock = (fake: number) => { offset = fake - Date.now(); writeFileSync(shiftFile, String(offset)); };
  const fakeNow = () => Date.now() + offset;
  setClock(start);
  writeFileSync(statePath, JSON.stringify(connectorState(world, start), null, 1));
  const preload = `--import=${clockJs}`;
  const mcpServers = Object.fromEntries(world.apps.map((app) => [app, { command: process.execPath, args: [appsJs, app], env: { APP_STATE: statePath, TZ_SHIFT_FILE: shiftFile, NODE_OPTIONS: preload, TZ: tz } }]));
  // a live run on Codex keeps its own CODEX_HOME in the sandbox and reaches the gateway as its Company endpoint
  const codex = values.engine === "codex";
  const instance = codex
    ? { driver: "codex", displayName: "Codex", environment: { DUSK_COMPANY_API_KEY: gateway.key, CODEX_HOME: join(root, "codex-home") }, config: { managed: { url: gateway.url, models: [values.model] } } }
    : { driver: "openai-compat", displayName: "OpenAI", config: { url: gateway.url, key: gateway.key, model: values.model } };
  if (codex) mkdirSync(join(root, "codex-home"), { recursive: true });
  const config = {
    instances: { gw: instance },
    mcpServers,
    memory: { captureQuietMs: CAPTURE_QUIET_MS },
  };
  const launch = async (): Promise<StressServer> => {
    for (let attempt = 0; ; attempt++) {
      try { return await launchServer(values.repo!, root, gateway, [values.model!], config, undefined, { env: { NODE_OPTIONS: preload, TZ_SHIFT_FILE: shiftFile, TZ: tz, DUSK_IDLE_SWEEP_MS: "20000" }, ...(codex ? { engine: "codex" as const } : {}) }); }
      catch (error) { if (attempt >= 3) throw error; await sleep(2_000 + Math.random() * 5_000); }
    }
  };
  const srv = await launch();
  live.add(srv);
  const api = client(srv.url);
  const watcher = watchFirstText(srv.url);
  const wallStart = Date.now();
  const localTime = (at = fakeNow()) => new Date(at).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const narration: Array<{ at: number; text: string }> = [];
  const chats: ChatRecord[] = [];
  const stepAt: Record<string, number> = {};
  const turns: TurnMetric[] = [];
  let personTurns = 0;
  const said: string[] = [];
  try {
    await api.call("PATCH", "/api/config", { profile: { name: world.persona.name, ...(world.persona.aboutMe ? { aboutMe: world.persona.aboutMe } : {}) } });
    const writeFiles = (files: Record<string, string>) => {
      for (const [path, body] of Object.entries(files)) { const full = join(srv.dataDir, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, body, { mode: /\.(sh|py|mjs|js)$/.test(path) || body.startsWith("#!") ? 0o755 : 0o644 }); }
    };
    writeFiles(resolveTimes(world.files ?? {}, start, tz));
    const bots = new Map<string, { id: string; threadId: string }>();
    bots.set(world.botName, await api.createBot(world.botName, values.model!));
    for (const extra of s.bots ?? []) {
      const bot = await api.createBot(extra.name, values.model!);
      const profile = { ...(extra.soul ? { soul: extra.soul } : {}), ...(extra.title ? { title: extra.title } : {}), ...(extra.description ? { description: extra.description } : {}) };
      if (Object.keys(profile).length) await api.call("PATCH", `/api/bots/${bot.id}`, profile);
      bots.set(extra.name, bot);
    }
    await sleep(3_000);
    stepAt[SETUP_DONE] = fakeNow();
    const threads = new Map<string, string>();
    let lastThread: string | undefined;
    const messages = async (threadId: string): Promise<ApiMsg[]> => (await api.call("GET", `/api/threads/${threadId}/messages?limit=400`)).messages;
    const updateState = (change: (state: any) => void) => { const state = JSON.parse(readFileSync(statePath, "utf8")); change(state); writeFileSync(statePath, JSON.stringify(state, null, 1)); };

    const busy = async () => {
      const [{ runs }, list] = await Promise.all([api.call("GET", "/api/routines?since=0").catch(() => ({ runs: [] })), api.bots().catch(() => [])]);
      return (runs as any[]).some((r) => ["queued", "running", "waiting"].includes(r.status) && (r.retryAt ?? 0) <= fakeNow()) || (list as any[]).some((b) => b.busy);
    };
    const settle = async (seconds: number) => {
      await sleep(seconds * 1_000);
      const deadline = Date.now() + 6 * 60_000;
      while (Date.now() < deadline && await busy()) await sleep(4_000);
    };

    const chatSteps = s.steps.filter((st) => "chat" in st).length;
    let chatIndex = 0;
    let advancedFrom: number | null = null;
    for (const step of s.steps as Step[]) {
      const label = "chat" in step ? step.chat.label : step.label;
      // what an advance set off (a routine whose time it crossed) belongs to the step that waits for it
      if (label) stepAt[label] = advancedFrom !== null && ("settle" in step || "inject" in step) ? advancedFrom : fakeNow();
      advancedFrom = "advance" in step ? fakeNow() : null;
      if ("advance" in step) {
        const target = relEpoch(`@${step.advance}`, fakeNow(), tz)!;
        if (target <= fakeNow()) throw new Error(`advance ${step.advance} does not move the clock forward`);
        narration.push({ at: target, text: `[time passes: it is now ${localTime(target)}]` });
        // a routine starts only close to its time, as on a computer that stays awake: stop just before each one the
        // jump crosses and let real seconds carry the clock past it
        for (let stop = 0; stop < MAX_ROUTINE_STOPS; stop++) {
          const ids = new Set([...bots.values()].map((b) => b.id));
          const { routines } = await api.call("GET", "/api/routines?since=0").catch(() => ({ routines: [] }));
          const due = (routines as any[]).filter((r) => ids.has(r.botId) && r.enabled !== false && typeof r.nextRunAt === "number" && r.nextRunAt > fakeNow() && r.nextRunAt <= target).sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
          if (!due) break;
          setClock(due.nextRunAt - 15_000);
          const deadline = Date.now() + 150_000;
          while (Date.now() < deadline) {
            await sleep(3_000);
            const { routines: now } = await api.call("GET", "/api/routines?since=0").catch(() => ({ routines: [] }));
            const same = (now as any[]).find((r) => r.id === due.id);
            if (!same || same.nextRunAt !== due.nextRunAt) break;
          }
          await settle(5);
        }
        if (target > fakeNow()) setClock(target);
        await sleep(2_000);
        continue;
      }
      if ("inject" in step) {
        const items = resolveTimes(step.inject, fakeNow(), tz) as Record<string, any>;
        const { files, ...apps } = items;
        if (files) writeFiles(files);
        updateState((state) => {
          const filled = { ...apps, ...(apps.mail ? { mail: apps.mail.map((m: any, i: number) => ({ id: `m${Date.now().toString(36)}${i}`, to: world.profile.email, labels: ["INBOX"], read: false, date: new Date(fakeNow()).toISOString(), ...m })) } : {}) };
          Object.assign(state, deepMerge(state, filled));
        });
        narration.push({ at: fakeNow(), text: `[meanwhile, in ${first}'s apps: ${JSON.stringify(items).slice(0, 300)}]` });
        continue;
      }
      if ("fault" in step) { updateState((state) => { state.faults = { ...state.faults, ...step.fault }; }); continue; }
      if ("settle" in step) { await settle(step.settle.seconds ?? 60); continue; }

      const c = step.chat;
      chatIndex += 1;
      const botName = c.bot ?? world.botName;
      const bot = bots.get(botName)!;
      const key = c.thread ?? "new";
      let threadId: string;
      if (key === "new") threadId = await api.newThread(bot.id);
      else if (key === "main") threadId = bot.threadId;
      else if (key === "same") threadId = lastThread ?? await api.newThread(bot.id);
      else threadId = threads.get(key) ?? await api.newThread(bot.id);
      if (key !== "new" && key !== "same" && key !== "main") threads.set(key, threadId);
      lastThread = threadId;
      const record: ChatRecord = { label: c.label, botName, threadId, start: fakeNow(), end: fakeNow() };
      chats.push(record);
      const maxTurns = c.maxTurns ?? 5;
      const transcript = async () => render(await messages(threadId), { user: world.persona.name.split(" ")[0]!, bot: botName });
      let replyToId: string | undefined;
      if (c.replyTo) {
        const pattern = new RegExp(c.replyTo, "i");
        const pool = (await Promise.all([...new Set([threadId, ...chats.map((one) => one.threadId)])].map(messages))).flat();
        replyToId = pool.filter((m) => m.role === "bot" && m.kind === "text" && pattern.test(m.text ?? "")).sort((a, b) => b.at - a.at)[0]?.id;
        if (replyToId) narration.push({ at: fakeNow(), text: `[${first} replies to the bot's message: "${(pool.find((m) => m.id === replyToId)?.text ?? "").slice(0, 160)}"]` });
      }
      const saidBefore = said.length;
      let text = c.opener ?? await personReply(personGateway, { persona: world.persona, goal: c.goal, knows: c.knows, now: localTime(), transcript: "(nothing yet: you open the conversation)", turnsLeft: maxTurns, before: said.slice(0, saidBefore) });
      for (let turn = 0; turn < maxTurns; turn++) {
        if (text.includes(DONE)) break;
        watcher.arm(threadId);
        const sent = Date.now();
        const accepted = await api.call("POST", `/api/bots/${bot.id}/messages`, { text, threadId, sendId: randomUUID().replaceAll("-", ""), ...(turn === 0 && replyToId ? { replyToId } : {}) });
        // `/new` moves the person to a fresh chat: the conversation goes on there, as it does in the app
        if (accepted?.command === "new" && typeof accepted.threadId === "string" && accepted.threadId !== threadId) {
          narration.push({ at: fakeNow(), text: `[${first} starts a new chat with ${botName}]` });
          threadId = accepted.threadId;
          lastThread = threadId;
          record.threadId = threadId;
          if (key !== "new" && key !== "same" && key !== "main") threads.set(key, threadId);
        }
        personTurns += 1;
        said.push(`${localTime()} (to ${botName}): ${text.slice(0, 300)}`);
        const state = await waitIdle(api, threadId, TURN_TIMEOUT_MS);
        turns.push({ latencyMs: Date.now() - sent, ttftMs: watcher.read(threadId), state });
        if (turn === maxTurns - 1) break;
        text = await personReply(personGateway, { persona: world.persona, goal: c.goal, knows: c.knows, now: localTime(), transcript: await transcript(), turnsLeft: maxTurns - turn - 1, before: said.slice(0, saidBefore) });
      }
      record.end = fakeNow();
      // memory upkeep files facts once a conversation is quiet; a later conversation should be able to use them
      if (chatIndex < chatSteps) await api.waitCapture(bot.id, record.end - 1, CAPTURE_QUIET_MS + 120_000).catch(() => false);
    }
    await settle(5);

    // evidence
    const botIds = new Map([...bots].map(([name, b]) => [b.id, name]));
    const { routines, runs } = await api.call("GET", "/api/routines?since=0").catch(() => ({ routines: [], runs: [] }));
    const ours = (routines as any[]).filter((r) => botIds.has(r.botId));
    const allBots = (await api.call("GET", "/api/bots?messages=0")).bots as any[];
    const threadOwners = new Map<string, string>();
    for (const b of allBots) if (botIds.has(b.id)) for (const t of b.tasks ?? []) threadOwners.set(t.threadId, botIds.get(b.id)!);
    for (const r of runs as any[]) if (r.threadId && botIds.has(r.botId)) threadOwners.set(r.threadId, botIds.get(r.botId)!);
    // a quiet run's NOTHING NEW line is hidden in the app, so the person never saw it
    const raw = (await Promise.all([...threadOwners].map(async ([threadId, botName]) => (await messages(threadId).catch(() => [])).filter((m) => !m.quietRun).map((m) => ({ ...m, threadId, botName }))))).flat();
    const msgs: Msg[] = raw.filter((m) => m.kind === "text" && m.text).map((m) => ({ id: m.id, at: m.at, role: m.role, kind: m.kind, text: m.text, threadId: m.threadId, botName: m.botName }));
    const digests = raw.filter((m) => m.kind === "digest" && m.digest);
    const memory: Record<string, string> = {};
    for (const [name, b] of bots) memory[name] = Object.values(await api.botMemory(b.id).catch(() => ({}))).join("\n");
    const aboutMe = await api.aboutMe().catch(() => "");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const evidence: Evidence = { state, routines: ours, runs: (runs as any[]).filter((r) => botIds.has(r.botId)), chats, messages: msgs, stepAt, memory, aboutMe, home: srv.dataDir, mainBot: world.botName };
    const checks = s.checks.map((c) => runCheck(c, evidence));

    const chatThreads = new Set(chats.map((c) => c.threadId));
    const proactive = new Set(proactiveMessages(evidence).map((m) => m.id));
    const lines = [
      ...narration,
      ...raw.filter((m) => (m.role === "user" || m.role === "bot") && m.kind === "text" && m.text).map((m) => {
        const automation = m.role === "user" && (!chatThreads.has(m.threadId) || AUTOMATION_PROMPT.test(m.text ?? ""));
        const who = automation ? "[automation run starts]" : m.role === "user" ? world.persona.name.split(" ")[0] : `${m.botName}${proactive.has(m.id) ? " [on its own]" : ""}`;
        const body = automation ? (m.text ?? "").slice(0, 160) : (m.text ?? "").slice(0, 2_000);
        return { at: m.at, text: `${localTime(m.at)} ${who} (${m.botName} chat ${m.threadId.slice(0, 4)}): ${body}` };
      }),
    ].sort((a, b) => a.at - b.at);
    const story = lines.map((l) => l.text).join("\n\n");
    const appWrites = JSON.stringify((state.log ?? []).map(({ at, ...rest }: any) => ({ at: localTime(Date.parse(at)), ...rest })), null, 0) + (state.errors?.length ? `\nerrors returned to the bot: ${JSON.stringify(state.errors).slice(0, 800)}` : "");
    const verdict = await judge(judgeGateway, s, world.persona, story, checks, appWrites);
    writeFileSync(join(out, "transcripts", `${s.id}-${run}.txt`), `${s.title}\n\n${story}\n\n--- app writes\n${appWrites}\n\n--- checks\n${checks.map((c) => `${c.ok ? "pass" : "FAIL"} ${c.label}: ${c.detail}`).join("\n")}\n\n--- judge\n${JSON.stringify(verdict, null, 1)}\n`);

    const usage = digests.reduce((t, m) => ({ input: t.input + (m.digest!.usage?.input ?? 0), output: t.output + (m.digest!.usage?.output ?? 0), cost: t.cost + (m.digest!.usage?.costUsd ?? 0), steps: t.steps + (m.digest!.toolCalls ?? 0) }), { input: 0, output: 0, cost: 0, steps: 0 });
    const estCost = usage.cost || (usage.input * Number(values["price-in"]) + usage.output * Number(values["price-out"])) / 1e6;
    const median = (xs: number[]) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)]! : null; };
    const recall = checks.filter((c) => c.recall);
    const success = checks.every((c) => c.ok);
    return {
      key: `${s.id}#${run}`, id: s.id, run, world: s.world, tags: s.tags, model: values.model, at: new Date().toISOString(),
      success, pass: success && verdict.done && verdict.score >= 4,
      checks: checks.map(({ label, ok, detail, recall }) => ({ label, ok, detail, ...(recall ? { recall } : {}) })),
      verdict,
      metrics: {
        personTurns, steps: usage.steps, failedTurns: turns.filter((t) => t.state !== "completed" && t.state !== "idle" && t.state !== "needs-input").length + raw.filter((m) => m.turnSucceeded === false && m.role === "bot" && m.kind === "text").length,
        ttftMs: median(turns.map((t) => t.ttftMs ?? NaN)), turnLatencyMs: median(turns.map((t) => t.latencyMs)), maxTurnLatencyMs: Math.max(0, ...turns.map((t) => t.latencyMs)),
        tokensIn: usage.input, tokensOut: usage.output, costUsd: Math.round(estCost * 1e4) / 1e4, costEstimated: !usage.cost,
        recall: recall.length ? { hit: recall.filter((c) => c.ok).length, of: recall.length } : null,
        routines: ours.length, routineRuns: evidence.runs.length, appErrors: state.errors?.length ?? 0, wallMs: Date.now() - wallStart,
      },
    };
  } finally {
    watcher.close();
    live.delete(srv);
    await srv.close(values.keep);
    if (!values.keep) rmSync(root, { recursive: true, force: true });
  }
}

const only = values.only ? new Set(values.only.split(",")) : null;
const tags = values.tag ? values.tag.split(",") : null;
const picked = loadScenarios().filter((s) => (!only || only.has(s.id)) && (!tags || s.tags.some((t) => tags.includes(t))));
const problems = [...new Set(picked.map((s) => s.world))].flatMap(validateWorld).concat(picked.flatMap(validate));
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).key as string) : []);
const queue: Array<{ s: Scenario; run: number }> = [];
for (let run = 1; run <= Number(values.repeat); run++) for (const s of picked) if (!done.has(`${s.id}#${run}`)) queue.push({ s, run });
log(`${queue.length} scenarios to run (${picked.length} picked, ${done.size} already in ${resultsPath})`);
await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, async () => {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    const started = Date.now();
    try {
      const result = await runScenario(job.s, job.run);
      appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
      const v = result.verdict as { score: number; patterns: string[]; why: string };
      const failed = (result.checks as Array<{ ok: boolean; label: string }>).filter((c) => !c.ok).map((c) => c.label);
      log(result.key, result.pass ? "PASS" : "fail", `score ${v.score}`, failed.length ? `failed: ${failed.join("; ")}` : "checks ok", v.patterns.join(","), `${Math.round((Date.now() - started) / 1000)}s`);
    } catch (error) {
      appendFileSync(resultsPath, `${JSON.stringify({ key: `${job.s.id}#${job.run}`, id: job.s.id, run: job.run, world: job.s.world, tags: job.s.tags, crashed: (error as Error).message.slice(0, 400), success: false, pass: false, checks: [], verdict: { score: 0, done: false, patterns: ["harness-crash"], why: (error as Error).message.slice(0, 200) } })}\n`);
      log(job.s.id, "CRASH", (error as Error).message);
    }
  }
}));
writeSummary(out, { label: values.label || undefined, repoCommit: git("rev-parse", "--short=10", "HEAD"), codeCommit: git("log", "-1", "--format=%h %cs %s", "--abbrev=10", "--", "server", "shared"), model: values.model });
log("done:", join(out, "summary.md"));
