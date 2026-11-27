// An Antigravity sign-in is one file the official CLI owns (antigravity-oauth-token). The CLI rewrites it when it renews
// the Google access token, and other processes of the same profile (model discovery, a turn, sign-out) share it. dusk bot
// keeps a second copy of the last file that held a refresh token and puts it back if the file is lost or left without
// one, so an interrupted rewrite or a stray removal never turns into "signed out".
import { chmod, readFile, rm, stat } from "node:fs/promises";

import { writeFileAtomic } from "../atomic.ts";

export const ANTIGRAVITY_SIGNIN_KEEP_SUFFIX = ".keep";
const MAX_TOKEN_BYTES = 1024 * 1024;

export interface AntigravityTokenPaths {
  tokenPath: string;
  legacyTokenPath?: string;
}

export type TokenState = "durable" | "short-lived" | "missing" | "corrupt";

const gates = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task for the same key finished, so two callers never renew or restore one sign-in at once. */
export function withAntigravitySignInGate<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = gates.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  gates.set(key, tail);
  void tail.then(() => { if (gates.get(key) === tail) gates.delete(key); });
  return run;
}

function holdsRefreshToken(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 3) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "refresh_token" && typeof entry === "string" && entry.length > 0) return true;
    if (holdsRefreshToken(entry, depth + 1)) return true;
  }
  return false;
}

/** Only a file that is not JSON, or holds nothing, is broken: a layout this code does not know still counts as a sign-in. */
export function classifyTokenFile(raw: string): TokenState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "corrupt";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) return "corrupt";
  return holdsRefreshToken(parsed) ? "durable" : "short-lived";
}

async function readToken(path: string): Promise<{ state: TokenState; raw: string }> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_TOKEN_BYTES) return { state: info.isFile() && info.size > 0 ? "corrupt" : "missing", raw: "" };
    const raw = await readFile(path, "utf8");
    return { state: classifyTokenFile(raw), raw };
  } catch {
    return { state: "missing", raw: "" };
  }
}

export const antigravityKeepPath = (tokenPath: string): string => `${tokenPath}${ANTIGRAVITY_SIGNIN_KEEP_SUFFIX}`;

export async function antigravityTokenState(tokenPath: string): Promise<TokenState> {
  return (await readToken(tokenPath)).state;
}

export type SignInCheck = "kept" | "restored" | "none";

/** The live file is the truth while it holds a refresh token: the copy follows it. When it does not, the copy comes
 * back. A live file with a different refresh token (a new sign-in, a renewal) always wins over the copy. */
export function ensureAntigravitySignIn(paths: AntigravityTokenPaths): Promise<SignInCheck> {
  return withAntigravitySignInGate(paths.tokenPath, async () => {
    const live = await readToken(paths.tokenPath);
    const keepPath = antigravityKeepPath(paths.tokenPath);
    if (live.state === "durable") {
      if ((await readToken(keepPath)).raw !== live.raw) writeFileAtomic(keepPath, live.raw, { mode: 0o600 });
      return "kept";
    }
    const kept = await readToken(keepPath);
    if (kept.state !== "durable") return "none";
    writeFileAtomic(paths.tokenPath, kept.raw, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(paths.tokenPath, 0o600).catch(() => {});
    console.warn(`antigravity: restored a Google sign-in that was ${live.state}`);
    return "restored";
  });
}

/** A person's own sign-out or a removed account: nothing may bring the sign-in back afterwards. */
export async function forgetAntigravitySignIn(paths: AntigravityTokenPaths): Promise<void> {
  await withAntigravitySignInGate(paths.tokenPath, async () => {
    await Promise.all([
      rm(antigravityKeepPath(paths.tokenPath), { force: true, maxRetries: 4, retryDelay: 250 }),
      rm(paths.tokenPath, { force: true, maxRetries: 4, retryDelay: 250 }),
      ...(paths.legacyTokenPath ? [rm(paths.legacyTokenPath, { force: true, maxRetries: 4, retryDelay: 250 })] : []),
    ]);
  });
}

/** A sign-in the person just made replaces whatever the copy held, even if the new file carries no refresh token. */
export async function acceptNewAntigravitySignIn(paths: AntigravityTokenPaths): Promise<void> {
  await withAntigravitySignInGate(paths.tokenPath, () =>
    rm(antigravityKeepPath(paths.tokenPath), { force: true, maxRetries: 4, retryDelay: 250 }));
  await ensureAntigravitySignIn(paths);
}
