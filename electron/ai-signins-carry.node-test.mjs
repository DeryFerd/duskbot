import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CARRIED_DRIVERS, carriedEngines, localAiSignIns } from "./ai-signins-carry.mjs";
import { carryAiKeys } from "./cloud-welcome-carry.mjs";
import * as shared from "../shared/ai-signins.ts";

test("carries only the kinds a second computer may renew too, with the engines the Cloud names for them", () => {
  const movable = shared.AI_SIGNIN_KINDS.filter((kind) => !shared.ROTATING_AI_SIGNIN_KINDS.has(kind));
  assert.deepEqual(Object.keys(CARRIED_DRIVERS), movable);
  for (const kind of movable) assert.deepEqual(CARRIED_DRIVERS[kind], shared.AI_SIGNIN_DRIVERS[kind]);
});

test("reads the Gemini login kept in a file, and never a ChatGPT, Grok or Kimi one whose refresh token is single-use", async () => {
  const home = mkdtempSync(join(tmpdir(), "dusk-carry-"));
  try {
    assert.deepEqual(await localAiSignIns({ home }), []);
    const put = (path, text) => { mkdirSync(join(home, ...path.slice(0, -1)), { recursive: true }); writeFileSync(join(home, ...path), text); };
    put([".codex", "auth.json"], JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }));
    put([".grok", "auth.json"], JSON.stringify({ "https://auth.x.ai::id": { refresh_token: "r" } }));
    put([".kimi-code", "credentials", "kimi-code.json"], JSON.stringify({ access_token: "k", refresh_token: "r" }));
    assert.deepEqual(await localAiSignIns({ home }), []);
    put([".gemini", "oauth_creds.json"], "not json");
    assert.deepEqual(await localAiSignIns({ home }), []);
    put([".gemini", "oauth_creds.json"], JSON.stringify({ access_token: "g", refresh_token: "r" }));
    const items = await localAiSignIns({ home });
    assert.deepEqual(items.map(({ kind }) => kind), ["gemini-oauth"]);
    assert.ok(shared.parseAiSignInList(items), "what is read is what the Admin takes");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("names the engines whose sign-in goes along: a carried login's, or a key's", () => {
  const instances = [
    { instanceId: "codex", driverKind: "codex" }, { instanceId: "claude", driverKind: "claudeAgent" }, { instanceId: "gemini", driverKind: "geminiAgent" },
    { instanceId: "openrouter", driverKind: "openaiChat" }, { instanceId: "cursor", driverKind: "cursorAgent" },
  ];
  assert.deepEqual(carriedEngines(instances, ["gemini-oauth"], ["openrouter"]), ["gemini", "openrouter"]);
  assert.deepEqual(carriedEngines(instances, ["codex-auth"]), [], "a ChatGPT login an older build read stays on its computer");
  assert.deepEqual(carriedEngines(null, ["gemini-oauth"]), []);
});

test("the keys the cloud lacks go sealed, one at a time; a key it has stays its own", async () => {
  const calls = [], asked = [];
  const call = async (method, route, body) => {
    calls.push(`${method} ${route}`);
    if (route === "/api/cloud-connections") return { ok: true, status: 200, body: { connections: [{ id: "key:xai", kind: "key", label: "xAI" }] } };
    if (route === "/api/seal-key") return { ok: false, status: 404, body: null };
    return { ok: true, status: 200, body: { saved: body } };
  };
  const localJson = async () => ({ connections: [
    { id: "key:openrouter", kind: "key", label: "OpenRouter" }, { id: "key:xai", kind: "key", label: "xAI" }, { id: "mcp:files", kind: "mcp", label: "files" },
  ] });
  const handoff = async (what) => { asked.push(what.id); return { connection: { config: { openrouter: {} } } }; };
  const lines = [];
  assert.deepEqual(await carryAiKeys({ call, localJson, handoff, log: (line) => lines.push(line) }), ["OpenRouter"]);
  assert.deepEqual(asked, ["key:openrouter"]);
  assert.deepEqual(calls, ["GET /api/cloud-connections", "PATCH /api/config"]);
  assert.deepEqual(await carryAiKeys({ call: async () => ({ ok: false, status: 401, body: null }), localJson, handoff }), [], "a cloud that didn't answer gets nothing");
});
