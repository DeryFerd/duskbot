// One renewal at a time per login, across every process of this install (the desktop's server, a cloud's server, each
// bot's CLI). Claude Code and Codex rotate a refresh token on every renewal, so two processes that renew the same login
// together leave the loser holding a retired token, which the provider answers with invalid_grant or "refresh token was
// already used". Whoever spawns an engine process while its login is due for renewal first takes this lock, and holds it
// until the renewal is saved (or the process is gone, or the limit passed); the next one then finds a fresh login.
//
// Security invariant: only fingerprints of tokens are compared here, never returned, logged or kept.
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RENEWAL_LOCK_STALE_MS = 60_000;
export const RENEWAL_WAIT_MS = 45_000;
export const RENEWAL_HOLD_MS = 20_000;
const POLL_MS = 200;

/** What a login file says about its renewal. `version` changes when the tokens do. */
export interface RenewalSource {
  /** The login's file; the lock is named after it, so every process on this install agrees on it. */
  key: string;
  due(now: number): boolean;
  version(): string | null;
}

export interface RenewalClock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Where lock files live. */
  lockDir?: string;
  waitMs?: number;
  holdMs?: number;
  staleMs?: number;
}

export interface RenewalHold {
  /** Keeps the lock until the renewal `child` may be making is saved, then releases it. */
  track(child: { exitCode: number | null; signalCode: NodeJS.Signals | null }): void;
  release(): void;
}

const NONE: RenewalHold = { track() {}, release() {} };

export const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");

const lockPath = (key: string, dir: string) => join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.lock`);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function stale(path: string, now: number, staleMs: number): boolean {
  try {
    const owner = Number(readFileSync(path, "utf8").split(" ")[0]);
    if (Number.isInteger(owner) && owner > 0 && !alive(owner)) return true;
    return now - statSync(path).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function tryTake(path: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    try { writeSync(fd, `${process.pid} ${Date.now()}`); } finally { closeSync(fd); }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Resolves at once when the login is not due. Otherwise waits for the lock (never longer than `waitMs`: a turn is not
 * held back for good) and gives it up again, with nothing to track, when the renewal landed while it waited. */
export async function enterRenewal(source: RenewalSource | null, clock: RenewalClock = {}): Promise<RenewalHold> {
  const now = clock.now ?? Date.now;
  if (!source || !source.due(now())) return NONE;
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  const dir = clock.lockDir ?? join(tmpdir(), "dusk-login-renewal");
  const path = lockPath(source.key, dir);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return NONE; }
  const end = now() + (clock.waitMs ?? RENEWAL_WAIT_MS);
  let held = false;
  try {
    while (!(held = tryTake(path))) {
      if (stale(path, now(), clock.staleMs ?? RENEWAL_LOCK_STALE_MS)) { try { rmSync(path, { force: true }); } catch {} continue; }
      if (now() >= end) return NONE;
      await sleep(POLL_MS);
      if (!source.due(now())) return NONE;
    }
  } catch {
    return NONE;
  }
  const release = () => {
    if (!held) return;
    held = false;
    try { rmSync(path, { force: true }); } catch {}
  };
  if (!source.due(now())) { release(); return NONE; }
  const before = source.version();
  let tracking = false;
  return {
    release,
    track(child) {
      if (tracking) return;
      tracking = true;
      const limit = now() + (clock.holdMs ?? RENEWAL_HOLD_MS);
      void (async () => {
        try {
          while (held && now() < limit && child.exitCode === null && child.signalCode === null) {
            await sleep(POLL_MS);
            try { if (source.version() !== before || !source.due(now())) break; } catch { break; }
          }
        } finally { release(); }
      })();
    },
  };
}
