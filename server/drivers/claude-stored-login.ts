// What Claude Code's plaintext credential file says about its claude.ai login, read without starting the CLI.
//
// Claude Code rotates the refresh token on every renewal. A short-lived claude process that renews an expired login and
// then exits or is killed before saving leaves the file holding a retired refresh token; the next process gets
// invalid_grant and blanks the login ("OAuth session expired and could not be refreshed"). Seen with `claude auth status`
// on 2.1.288 and with killed `claude -p` calls up to 2.1.329: https://github.com/anthropics/claude-code/issues/102265.
// So a login that is due for renewal is renewed only by a turn, and nothing kills a Claude process mid-renewal.
//
// Security invariant: tokens are only compared here, never returned, logged or kept.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { killCliTree } from "../procs.ts";
import { enterRenewal, type RenewalClock, type RenewalHold, type RenewalSource } from "./login-renewal.ts";

/** Claude Code renews within 5 minutes of expiry (2.1.288); the extra minutes cover a slow start. */
export const CLAUDE_RENEWAL_MARGIN_MS = 10 * 60_000;
const MAX_BYTES = 1_000_000;
const SETTLE_POLL_MS = 200;
export const CLAUDE_RENEWAL_SETTLE_MS = 15_000;

export type ClaudeStoredLogin =
  | { state: "none" }
  | { state: "blank" }
  | { state: "oauth"; expiresAt: number | null; renewable: boolean; accessHash: string };

/** Variables that sign the CLI in without its credential file. */
const ENV_LOGINS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export function claudeCredentialsFile(env: NodeJS.ProcessEnv): string | null {
  if (ENV_LOGINS.some((name) => env[name]?.trim())) return null;
  const home = env.HOME || env.USERPROFILE || homedir();
  const configured = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const dir = configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  return isAbsolute(dir) ? join(dir, ".credentials.json") : null;
}

export function readClaudeStoredLogin(file: string | null): ClaudeStoredLogin {
  if (!file) return { state: "none" };
  let oauth: Record<string, unknown> | null = null;
  try {
    if (statSync(file).size > MAX_BYTES) return { state: "none" };
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const inner = parsed && typeof parsed === "object" ? (parsed as { claudeAiOauth?: unknown }).claudeAiOauth : null;
    oauth = inner && typeof inner === "object" && !Array.isArray(inner) ? inner as Record<string, unknown> : null;
  } catch {
    return { state: "none" };
  }
  if (!oauth) return { state: "none" };
  const access = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
  const refresh = typeof oauth.refreshToken === "string" ? oauth.refreshToken : "";
  if (!access && !refresh) return { state: "blank" };
  const expiresAt = typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null;
  return { state: "oauth", expiresAt, renewable: refresh.length > 0, accessHash: createHash("sha256").update(access).digest("hex") };
}

/** The CLI will renew this login the next time it starts. */
export function claudeRenewalDue(login: ClaudeStoredLogin, now = Date.now()): boolean {
  return login.state === "oauth" && login.renewable && login.expiresAt !== null && login.expiresAt - now <= CLAUDE_RENEWAL_MARGIN_MS;
}

const renewalLanded = (before: ClaudeStoredLogin, after: ClaudeStoredLogin, now: number) =>
  after.state !== "oauth" || before.state !== "oauth" || after.accessHash !== before.accessHash || !claudeRenewalDue(after, now);

export interface RenewalWait {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limitMs?: number;
  /** The process has exited: nothing is left to wait for. */
  gone?: () => boolean;
}

/** Resolves once a renewal due in `file` has been saved (or failed, blanking it), the process is gone, or `limitMs` passed. */
export async function settleClaudeRenewal(file: string | null, wait: RenewalWait = {}): Promise<void> {
  const now = wait.now ?? Date.now;
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  const before = readClaudeStoredLogin(file);
  if (!claudeRenewalDue(before, now())) return;
  const end = now() + (wait.limitMs ?? CLAUDE_RENEWAL_SETTLE_MS);
  while (now() < end && !wait.gone?.()) {
    await sleep(SETTLE_POLL_MS);
    if (renewalLanded(before, readClaudeStoredLogin(file), now())) return;
  }
}

/** killCliTree for a Claude process, held while a renewal it may be making is unsaved. */
export async function killClaudeTree(
  child: Parameters<typeof killCliTree>[0],
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
  kill: typeof killCliTree = killCliTree,
): Promise<boolean> {
  await settleClaudeRenewal(claudeCredentialsFile(env), { gone: () => child.exitCode !== null || child.signalCode !== null });
  return kill(child, timeoutMs);
}

/** The renewal of the login `env` signs Claude in with, null when it has none in a file (a Mac keeps it in the Keychain,
 * where the CLI alone reads it, and a token in the environment never renews). */
export function claudeRenewalSource(env: NodeJS.ProcessEnv): RenewalSource | null {
  const file = claudeCredentialsFile(env);
  if (!file) return null;
  const read = () => readClaudeStoredLogin(file);
  return {
    key: file,
    due: (now) => claudeRenewalDue(read(), now),
    version: () => { const login = read(); return login.state === "oauth" ? login.accessHash : null; },
  };
}

/** Taken before a Claude process starts: only one of them renews a due login at a time, on the whole install. */
export function enterClaudeRenewal(env: NodeJS.ProcessEnv, clock?: RenewalClock): Promise<RenewalHold> {
  return enterRenewal(claudeRenewalSource(env), clock);
}

const AUTH_FAILURE_DEDUPE_MS = 5_000;
const authFailures = new Map<string, { at: number; count: number; signOut: boolean }>();

/** Whether a turn the CLI refused as signed out is a sign-out. A login whose file still holds its tokens is not one the
 * first time: a refresh in another process, a provider's bad minute or a token the CLI has not renewed yet all answer
 * 401 for one turn, and the next turn works. The same stored token refused again is a revoked login. A file that is
 * blank or gone is a sign-out at once, and a login with no file here (Keychain, environment) says nothing more than
 * the CLI did. Asking twice about one refusal (a few seconds apart) counts it once. */
export function claudeRefusalIsSignOut(env: NodeJS.ProcessEnv, now = Date.now()): boolean {
  const login = readClaudeStoredLogin(claudeCredentialsFile(env));
  if (login.state !== "oauth" || !login.renewable) return true;
  const known = authFailures.get(login.accessHash);
  if (known && now - known.at < AUTH_FAILURE_DEDUPE_MS) return known.signOut;
  const count = (known?.count ?? 0) + 1;
  const verdict = { at: now, count, signOut: count >= 2 };
  authFailures.set(login.accessHash, verdict);
  if (authFailures.size > 32) authFailures.delete(authFailures.keys().next().value!);
  return verdict.signOut;
}

export function claudeLoginRenewed(env: NodeJS.ProcessEnv): void {
  const login = readClaudeStoredLogin(claudeCredentialsFile(env));
  if (login.state === "oauth") authFailures.delete(login.accessHash);
}
