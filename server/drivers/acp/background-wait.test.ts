import { afterEach, describe, expect, it, vi } from "vitest";

import { WAKE_QUIET_MS, backgroundCall, backgroundWaitMs } from "./background-wait.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Antigravity background calls", () => {
  it.each([
    [{ name: "schedule", rawInput: { DurationSeconds: 30, Prompt: "wake" } }, { kind: "wakes", firesInMs: 30_000 }],
    [{ title: "Run schedule", kind: "other", rawInput: { DurationSeconds: 45 } }, { kind: "wakes", firesInMs: 45_000 }],
    [{ name: "schedule", rawInput: { DurationSeconds: 3 * 60 * 60 } }, { kind: "endless" }],
    [{ name: "schedule", rawInput: { Cron: "*/5 * * * *" } }, { kind: "endless" }],
    [{ name: "run_command", kind: "execute", rawInput: { CommandLine: "pnpm typecheck", IsDaemon: false } }, { kind: "wakes" }],
    [{ name: "run_command", kind: "execute", rawInput: { CommandLine: "pnpm dev", IsDaemon: true } }, { kind: "endless" }],
    [{ name: "invoke_subagent", kind: "other", rawInput: {} }, { kind: "wakes" }],
    [{ name: "view_file", kind: "read", rawInput: { AbsolutePath: "/a" } }, { kind: "other" }],
    [{ title: "Run manage_task", kind: "other", rawInput: { Action: "status" } }, { kind: "other" }],
  ])("reads %o as %o", (update, call) => {
    expect(backgroundCall(update)).toEqual(call);
  });

  it("waits on timers only until a while past the last one fires, and on other work up to the cap", () => {
    vi.stubEnv("DUSK_ACP_BACKGROUND_WAIT_MS", String(10 * 60_000));
    expect(backgroundWaitMs([{ kind: "wakes", firesInMs: 30_000 }, { kind: "wakes", firesInMs: 60_000 }])).toBe(60_000 + WAKE_QUIET_MS);
    expect(backgroundWaitMs([{ kind: "wakes", firesInMs: 30_000 }, { kind: "wakes" }])).toBe(10 * 60_000);
    expect(backgroundWaitMs([{ kind: "wakes", firesInMs: 9 * 60_000 }])).toBe(10 * 60_000);
  });
});
