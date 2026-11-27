// Codex keeps its own login in <CODEX_HOME>/auth.json unless config.toml moves it to the keyring
// (`cli_auth_credentials_store`, "file" by default in codex-cli 0.160.1).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execCli } from "../procs.ts";
import { codexHome } from "./codex-identity.ts";
import { enterRenewal, fingerprint, type RenewalClock, type RenewalHold, type RenewalSource } from "./login-renewal.ts";

type Env = Record<string, string | undefined>;

export function storedCodexLogin(env: Env): string | null {
  const home = codexHome(env);
  if (!home) return null;
  try { return readFileSync(join(home, "auth.json"), "utf8"); } catch { return null; }
}

/** Which sign-in a stored login is, without its secrets; null when there is no readable file to tell.
 * codex-cli 0.160.1 writes `auth_mode` ("chatgpt" or "apikey") and, for ChatGPT, `tokens.account_id`. */
export function codexSignInIdentity(stored: string | null): string | null {
  if (stored === null) return null;
  try {
    const auth = JSON.parse(stored) as { auth_mode?: unknown; tokens?: { account_id?: unknown } | null };
    return JSON.stringify([auth.auth_mode ?? null, auth.tokens?.account_id ?? null]);
  } catch { return null; }
}

const readable = (stored: string | null): boolean => {
  if (stored === null) return false;
  try { JSON.parse(stored); return true; } catch { return false; }
};

/** codex-cli 0.160.1 says "Logged in using …", "Not logged in", or "Error checking login status: …" for an auth.json it
 * cannot read; 0.165.0 says "API key configured - …" for an API-key login. */
export function codexReportsLogin(said: string): boolean {
  return /^(?:logged in|api key configured)\b/im.test(said);
}

export function codexLoginStatus(cli: string, env: Env): Promise<"signed-in" | "signed-out" | "unknown"> {
  return new Promise((resolve) => execCli(cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) => {
    const said = `${stdout}\n${stderr ?? ""}`;
    resolve(!err && codexReportsLogin(said) ? "signed-in"
      : err && /^(?:not logged in|error checking login status)\b/im.test(said) ? "signed-out" : "unknown");
  }));
}

/** Without a login Codex still runs a turn and fails only after a minute of reconnects. Only Codex's own "not
 * logged in" counts, and a login it reads from elsewhere is remembered so later turns skip the check, until
 * `forget` is called because a turn found that login gone. */
export function codexLoginCheck(cli: string): { check: (env: Env) => Promise<"missing" | "present">; forget: () => void } {
  let confirmedWithout: string | null | undefined;
  let forgets = 0;
  return {
    check: async (env) => {
      const stored = storedCodexLogin(env);
      if (readable(stored) || stored === confirmedWithout) return "present";
      const forgetsBefore = forgets;
      const status = await codexLoginStatus(cli, env);
      if (status === "signed-in" && forgets === forgetsBefore) confirmedWithout = stored;
      // Another Codex may be rewriting auth.json: a half-written file is not a missing login.
      return status === "signed-out" && !readable(storedCodexLogin(env)) ? "missing" : "present";
    },
    forget: () => { forgets += 1; confirmedWithout = undefined; },
  };
}

/** Codex renews a ChatGPT login whose access token is about to end, or whose last renewal is over a week old (codex-cli
 * 0.160 keeps 8 days); the margin covers a slow start. */
export const CODEX_RENEWAL_MARGIN_MS = 10 * 60_000;
export const CODEX_RENEWAL_AGE_MS = 7 * 86_400_000;

function jwtExpiry(token: unknown): number | null {
  if (typeof token !== "string") return null;
  try {
    const exp = (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}

/** The ChatGPT login's renewal facts, read without starting Codex; tokens are only compared, never returned. */
export function codexRenewalState(stored: string | null, now: number): { due: boolean; version: string | null } {
  if (stored === null) return { due: false, version: null };
  try {
    const auth = JSON.parse(stored) as { tokens?: { access_token?: unknown; refresh_token?: unknown } | null; last_refresh?: unknown };
    const refresh = auth.tokens?.refresh_token;
    if (typeof refresh !== "string" || !refresh) return { due: false, version: null };
    const expiry = jwtExpiry(auth.tokens?.access_token);
    const last = typeof auth.last_refresh === "string" ? Date.parse(auth.last_refresh) : NaN;
    const due = (expiry !== null && expiry - now <= CODEX_RENEWAL_MARGIN_MS) || (Number.isFinite(last) && now - last >= CODEX_RENEWAL_AGE_MS);
    return { due, version: fingerprint(refresh) };
  } catch { return { due: false, version: null }; }
}

export function codexRenewalSource(env: Env): RenewalSource | null {
  const home = codexHome(env);
  if (!home) return null;
  return {
    key: join(home, "auth.json"),
    due: (now) => codexRenewalState(storedCodexLogin(env), now).due,
    version: () => codexRenewalState(storedCodexLogin(env), Date.now()).version,
  };
}

/** Taken before a Codex process starts: only one of them renews a due ChatGPT login at a time, on the whole install. */
export function enterCodexRenewal(env: Env, clock?: RenewalClock): Promise<RenewalHold> {
  return enterRenewal(codexRenewalSource(env), clock);
}
