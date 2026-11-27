import "../testing/scrub-ambient-dusk-env.ts";

import { describe, expect, it, vi } from "vitest";

import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

type Rec = Record<string, any>;

function workspace(instances: Rec[], bots: Rec[], config: Rec = {}, args = ["--json"]) {
  const request = vi.fn(async (path: string) => {
    if (path === "/.well-known/duskbot/environment") return { version: "0.0.0", label: "Fixture", capabilities: { jobs: true } };
    if (path === "/api/auth/session") return { kind: "loopback", scopes: ["admin", "client"] };
    if (path === "/api/config") return config;
    if (path === "/api/bots?messages=0") return { bots, groups: [] };
    throw new Error(`unexpected ${path}`);
  });
  const callTool = vi.fn(async (name: string) => {
    if (name === "get_system_health") return { status: "connected", app: "duskbot" };
    if (name === "list_available_models") return { instances };
    throw new Error(`unexpected tool ${name}`);
  });
  return async () => {
    const out: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: () => undefined, readStdin: async () => "" };
    const code = await runHeadless(["doctor", ...args], { io, env: { DUSK_URL: "http://127.0.0.1:19996" }, request: request as any, callTool: callTool as any });
    return { code, out, result: args.includes("--json") ? JSON.parse(out.at(-1)!) : null };
  };
}

const botOn = (instanceId: string, id = instanceId) => ({ id, name: id, modelSelection: { instanceId, model: "m" } });

describe("doctor", () => {
  it("names the engine a bot uses and why it cannot answer, instead of advice about API keys", async () => {
    const { code, result } = await workspace(
      [{ instanceId: "claude", displayName: "Claude Code", snapshot: { state: "unavailable", reason: "`claude` CLI not found" } },
        { instanceId: "mistral", snapshot: { state: "unavailable", reason: "No Mistral API key" } }],
      [botOn("claude", "a"), botOn("claude", "b")],
    )();
    expect(code).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      "claude (Claude Code), used by 2 bots, cannot answer: `claude` CLI not found: reinstall it or fix its path in Settings › Models",
    ]);
  });

  it("never counts a signed-out engine as ready", async () => {
    const { result } = await workspace([{ instanceId: "chatgpt", displayName: "ChatGPT plan", snapshot: { state: "available", authenticated: false } }], [botOn("chatgpt")])();
    expect(result.ok).toBe(false);
    expect(result.availableEngines).toEqual([]);
    expect(result.problems).toEqual(["chatgpt (ChatGPT plan), used by 1 bot, cannot answer: signed out: sign in again in Settings › Models"]);
  });

  it("is ready with one working engine and warns about a bot whose engine is broken", async () => {
    const { code, result } = await workspace(
      [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } },
        { instanceId: "chatgpt", snapshot: { state: "available", authenticated: false } },
        { instanceId: "local", access: "custom", snapshot: { state: "available", authenticated: false } }],
      [botOn("claude"), botOn("chatgpt")],
    )();
    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.availableEngines).toEqual(["claude", "local"]);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toContain("chatgpt, used by 1 bot, cannot answer: signed out: sign in again in Settings › Models");
  });

  it("keeps the setup advice when no engine is set up and no bot is waiting on one", async () => {
    const { result } = await workspace([{ instanceId: "mistral", snapshot: { state: "unavailable", reason: "No Mistral API key" } }], [])();
    expect(result.problems).toEqual(["no engine is available: set one up with `duskbot engine set KIND --key-env VAR`"]);
  });

  it("says the bots have no browser when the engine is installed but there is no Chrome for it to start (Linux ARM64)", async () => {
    const engines = [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }];
    const config = { browserEngine: { kind: "engine", version: "0.37.0", noBrowser: true, engine: "agent-browser", myChrome: false } };
    const { result } = await workspace(engines, [], config)();
    expect(result.warnings).toEqual(["bots have no built-in browser here: the engine is installed, but there is no Chrome or Chromium for it to start (install one with `duskbot browser install` as the user running serve)"]);
    const { out } = await workspace(engines, [], config, [])();
    expect(out.join("\n")).toContain("Bots' browser: not available");
    expect(out.join("\n")).not.toContain("Bots' browser: installed");
    const ready = await workspace(engines, [], { browserEngine: { ...config.browserEngine, noBrowser: undefined } }, [])();
    expect(ready.out.join("\n")).toContain("Bots' browser: installed (0.37.0)");
  });
});
