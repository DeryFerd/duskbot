// AI sign-ins the Admin held for this Cloud while it was being made (apps/dashboard/server/clouds/ai-stash.ts), pushed once
// over the signed home channel. Never log what arrives. A login already on this Cloud wins: a held one never replaces it, and
// a login with a single-use refresh token is never written (shared/ai-signins.ts ROTATING_AI_SIGNIN_KINDS).
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { AI_SIGNIN_DRIVERS, KIMI_TOKEN_FILE, ROTATING_AI_SIGNIN_KINDS, parseAiSignInList, type AiSignIn } from "../shared/ai-signins.ts";
import { codexHome } from "./drivers/codex-identity.ts";
import { harnessHome, userHome } from "./env-path.ts";

export const CLOUD_AI_SIGNINS_PATH = "/api/cloud/ai-signins";

export type CloudAiSignIn = AiSignIn;

export function parseCloudAiSignIns(value: unknown): CloudAiSignIn[] | null {
  if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 1) return null;
  return parseAiSignInList((value as { items?: unknown }).items);
}

/** Where each CLI reads its login, as its driver does; null when the home is not a full path. */
function loginFile(item: CloudAiSignIn, env: Record<string, string | undefined>): string | null {
  switch (item.kind) {
    case "codex-auth": { const home = codexHome(env); return home ? join(home, "auth.json") : null; }
    case "grok-auth": return join(env.GROK_HOME || harnessHome("grok", env), "auth.json");
    case "gemini-oauth": return join(userHome(env), ".gemini", "oauth_creds.json");
    case "kimi-auth": return join(env.KIMI_CODE_HOME || harnessHome("kimi-code", env), "credentials", item.file!);
  }
}

/** Kimi keeps one token file per region; any of them is a login already here. */
function signedInAlready(item: CloudAiSignIn, file: string): boolean {
  if (item.kind !== "kimi-auth") return existsSync(file);
  try { return readdirSync(dirname(file)).some((name) => KIMI_TOKEN_FILE.test(name)); } catch { return false; }
}

/** Writes each sign-in where its engine reads it; `applied` names the kinds that landed, `kept` those already signed in
 * here, `refused` the logins a desktop still sends whose refresh token another computer renews too. */
export function applyCloudAiSignIns(items: readonly CloudAiSignIn[], env: Record<string, string | undefined>): { applied: string[]; kept: string[]; refused: string[] } {
  const applied: string[] = [], kept: string[] = [], refused: string[] = [];
  for (const item of items) {
    if (ROTATING_AI_SIGNIN_KINDS.has(item.kind)) { refused.push(item.kind); continue; }
    const file = loginFile(item, env);
    if (!file || !isAbsolute(file)) continue;
    if (signedInAlready(item, file)) { kept.push(item.kind); continue; }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, item.auth, { mode: 0o600 });
    renameSync(temp, file);
    applied.push(item.kind);
  }
  return { applied, kept, refused };
}

/** The engines (driver kinds) the `applied` sign-ins sign in. */
export function signedInDrivers(applied: readonly string[]): Set<string> {
  return new Set(applied.flatMap((kind) => AI_SIGNIN_DRIVERS[kind as keyof typeof AI_SIGNIN_DRIVERS] ?? []));
}
