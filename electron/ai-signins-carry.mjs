// This computer's AI sign-ins that can go to the person's own Cloud (shared/ai-signins.ts): the CLI logins kept in a
// plain file whose refresh token can be used from two computers. Claude Code, Cursor and Copilot keep theirs in the OS
// keychain, tied to this computer, so they stay. ChatGPT (Codex), Grok and Kimi Code renew with a single-use refresh
// token, so a copy would sign one of the two computers out at its next renewal; the Cloud signs those in on its own.
//
// Security invariant: what is read here goes only to cloudAccount.holdSignIns; never log it.
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BYTES = 32 * 1024;

/** The engines (driver kinds) each sign-in signs in, as shared/ai-signins.ts says for the kinds that may move. */
export const CARRIED_DRIVERS = { "gemini-oauth": ["geminiAgent"] };

const files = (home) => ({
  "gemini-oauth": path.join(home, ".gemini", "oauth_creds.json"),
});

async function jsonObject(file, fs) {
  try {
    const text = await fs.readFile(file, "utf8");
    if (!text || Buffer.byteLength(text) > MAX_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { text, parsed } : null;
  } catch { return null; }
}

/** The sign-ins on this computer that can go to the Cloud, at most one of each kind. */
export async function localAiSignIns({ home = os.homedir(), fs = fsp } = {}) {
  const items = [];
  for (const [kind, file] of Object.entries(files(home))) {
    const read = await jsonObject(file, fs);
    if (read) items.push({ kind, auth: read.text });
  }
  return items;
}

/** The engines here (instance ids) whose sign-in goes along: those a carried login signs in, and those run on a key
 * the move to the Cloud takes (`keyEngines`, cloud-connections' "key:" items). */
export function carriedEngines(instances, kinds, keyEngines = []) {
  const drivers = new Set(kinds.flatMap((kind) => CARRIED_DRIVERS[kind] ?? []));
  const keys = new Set(keyEngines);
  return (Array.isArray(instances) ? instances : [])
    .filter((instance) => typeof instance?.instanceId === "string" && (drivers.has(instance.driverKind) || keys.has(instance.instanceId)))
    .map((instance) => instance.instanceId);
}
