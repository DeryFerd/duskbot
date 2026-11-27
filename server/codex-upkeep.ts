// A dusk cloud's image ships Codex in a folder owned by the machine user, not the one the server runs as, so
// `codex update` cannot replace it; the newest stable release goes into the server's own engine folder instead.
import type { ProviderRegistry } from "./harness/registry.ts";
import { installNpmEngine } from "./engine-install.ts";
import { augmentedPath } from "./env-path.ts";
import { execCli } from "./procs.ts";
import { codexVersionBehind, readLatestCodexReleaseAge, type CodexRelease } from "./drivers/codex-release.ts";

export const CODEX_PACKAGE = "@openai/codex";
/** The oldest Codex a cloud keeps: ChatGPT's newer models (gpt-6.2-sol) need 0.166. Below it the update runs even when
 * the release lookup fails. */
export const CODEX_MIN_VERSION = "0.166.0";
/** A newer release is installed once it has been out this long, so a broken one is usually pulled or fixed first. The
 * minimum above never waits. */
export const CODEX_SOAK_MS = 48 * 60 * 60_000;

const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const BUSY_RETRY_MS = 2 * 60_000;
const FAILED_RETRY_MS = 60 * 60_000;

export interface CodexUpkeepDeps {
  /** What `codex --version` says for the copy the engine runs, null when none starts. */
  installedVersion(): Promise<string | null>;
  /** The newest stable release, null when the lookup fails. */
  latestRelease(): Promise<CodexRelease | null>;
  now(): number;
  turnsRunning(): number;
  /** An exact release, or the latest when the lookup failed. */
  install(version: string | undefined): Promise<void>;
  /** After an update: the engines read their CLI again. */
  updated(): Promise<void>;
  log(line: string): void;
}

export type CodexUpkeepResult =
  | { result: "current"; version: string }
  | { result: "soaking"; version: string; release: string }
  | { result: "busy" }
  | { result: "updated"; from: string | null; to: string }
  | { result: "failed"; from: string | null };

function belowMinimum(installed: string | null): boolean {
  return !installed || codexVersionBehind(installed, CODEX_MIN_VERSION);
}

/** What to install now: `undefined` version means the latest; null means nothing yet. A release without a known publish
 * time never counts as soaked. */
export function codexUpdateTarget(installed: string | null, release: CodexRelease | null, now: number): { version: string | undefined } | null {
  if (belowMinimum(installed)) return { version: release?.version };
  if (!release || !codexVersionBehind(installed!, release.version)) return null;
  return release.publishedAt !== null && now - release.publishedAt >= CODEX_SOAK_MS ? { version: release.version } : null;
}

export async function codexUpkeepOnce(deps: CodexUpkeepDeps): Promise<CodexUpkeepResult> {
  const [installed, release] = await Promise.all([deps.installedVersion(), deps.latestRelease()]);
  const target = codexUpdateTarget(installed, release, deps.now());
  if (!target) {
    return release && codexVersionBehind(installed!, release.version)
      ? { result: "soaking", version: installed!, release: release.version }
      : { result: "current", version: installed! };
  }
  // npm replaces the package in place; a turn starting meanwhile could find it half written.
  if (deps.turnsRunning() > 0) return { result: "busy" };
  try {
    await deps.install(target.version);
  } catch (error) {
    deps.log(`codex upkeep: the update from ${installed ?? "none"} failed: ${error instanceof Error ? error.message : String(error)}`);
    return { result: "failed", from: installed };
  }
  const now = await deps.installedVersion();
  if (belowMinimum(now) || (target.version && codexVersionBehind(now!, target.version))) {
    deps.log(`codex upkeep: npm finished, but codex reports ${now ?? "nothing"} (was ${installed ?? "none"})`);
    return { result: "failed", from: installed };
  }
  deps.log(`codex upkeep: updated ${installed ?? "none"} -> ${now!}`);
  await deps.updated().catch((error: unknown) => deps.log(`codex upkeep: engines could not be read again: ${error instanceof Error ? error.message : String(error)}`));
  return { result: "updated", from: installed, to: now! };
}

export function startCodexUpkeep(deps: CodexUpkeepDeps, timing = { first: FIRST_CHECK_MS, every: CHECK_EVERY_MS, busy: BUSY_RETRY_MS, failed: FAILED_RETRY_MS }): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    timer.unref?.();
  };
  const tick = async () => {
    let next = timing.every;
    try {
      const outcome = await codexUpkeepOnce(deps);
      if (outcome.result === "busy") next = timing.busy;
      else if (outcome.result === "failed") next = timing.failed;
    } catch (error) {
      deps.log(`codex upkeep: check failed: ${error instanceof Error ? error.message : String(error)}`);
      next = timing.failed;
    }
    schedule(next);
  };
  schedule(timing.first);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

/** On by default on a dusk cloud; DUSK_CODEX_AUTO_UPDATE=0 turns it off, =1 turns it on for another server. */
export function codexAutoUpdateEnabled(cloudHome: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.DUSK_CODEX_AUTO_UPDATE;
  return flag === "1" || (cloudHome && flag !== "0");
}

/** POSIX looks `codex` up on the spawn's own PATH, so it is the one the engines spawn with: the app's folder first. */
export function readCodexVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execCli("codex", ["--version"], { env: { ...process.env, PATH: augmentedPath() }, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, stdout) => {
      const version = error ? "" : String(stdout).trim().split("\n")[0]!.trim();
      resolve(version || null);
    });
  });
}

export function codexUpkeepFor(registry: Pick<ProviderRegistry, "entries" | "forgetSnapshots" | "readEngine">, turnsRunning: () => number, log: (line: string) => void): CodexUpkeepDeps {
  return {
    installedVersion: readCodexVersion,
    latestRelease: readLatestCodexReleaseAge,
    now: Date.now,
    turnsRunning,
    install: (version) => installNpmEngine(CODEX_PACKAGE, { cli: "codex", ...(version ? { version } : {}) }),
    updated: async () => {
      registry.forgetSnapshots();
      const codex = registry.entries().filter((entry) => entry.live?.driverKind === "codex");
      await Promise.all(codex.map((entry) => registry.readEngine(entry.instanceId, true)));
    },
    log,
  };
}
