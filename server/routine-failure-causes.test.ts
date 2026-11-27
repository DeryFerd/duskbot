import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { RoutineProbe } from "../shared/routines.ts";
import { createRoutineProbes } from "./routine-probe.ts";
import type { ScriptResult } from "./routine-script.ts";
import { RoutineManager, type Routine, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";
import { createUsageOutbox } from "./usage-signals.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = new Date(2026, 7, 17, 8, 0, 0).getTime();
const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
type EventBody = RuntimeEvent extends infer E ? E extends RuntimeEvent ? Omit<E, "eventId" | "provider" | "threadId" | "createdAt"> : never : never;

function harness(extra: Partial<RoutineManagerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dusk-routine-causes-"));
  dirs.push(dir);
  let now = START, tasks = 0;
  let dispatchError: string | null = null;
  const started: string[] = [];
  const failed: RoutineRun[] = [];
  const alerts: unknown[] = [];
  const options: RoutineManagerOptions = {
    file: join(dir, "routines.json"),
    now: () => now,
    botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++tasks}` }),
    startTurn: async (_botId, threadId, _prompt, _runOn, _trigger, onDispatchError) => {
      started.push(threadId);
      if (dispatchError) onDispatchError?.(dispatchError);
    },
    onRunFailed: (run, alert) => { failed.push(run); alerts.push(alert); },
    onRunDeferred: (_run, alert) => { if (alert) alerts.push(alert); },
    ...extra,
  };
  const manager = new RoutineManager(options);
  const event = (threadId: string, body: EventBody) =>
    manager.handleRuntimeEvent({ eventId: `event-${Math.random()}`, provider: "fake", threadId, createdAt: new Date(0).toISOString(), ...body } as RuntimeEvent);
  // what the workspace reports for a finished run: the usage outbox's record of it
  const reported = (run: RoutineRun) => {
    const outbox = createUsageOutbox({ now: () => now });
    outbox.run(run);
    const record = outbox.take()!.runs[0]!;
    return { outcome: record.outcome, reason: record.reason };
  };
  return {
    manager, started, failed, alerts, event, reported,
    dispatchFails: (message: string | null) => { dispatchError = message; },
    advance: async (ms: number) => { now += ms; await manager.tick(); },
    setNow: (at: number) => { now = at; },
    run: (id: string) => manager.listRuns().find((run) => run.id === id)!,
    routine: (patch: Partial<Parameters<RoutineManager["create"]>[0]> = {}) =>
      manager.create({ name: "Inbox sweep", prompt: "Sweep the inbox", botId: "maus-1", schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...patch }),
    start: async (routineId: string) => {
      const run = manager.runNow(routineId)!;
      await manager.tick();
      return manager.listRuns().find((candidate) => candidate.id === run.id)!;
    },
    fail: (threadId: string, message: string, extra: { stopReason?: string } & Partial<Extract<RuntimeEvent, { type: "runtime.error" }>> = {}) => {
      const { stopReason, ...flags } = extra;
      event(threadId, { type: "runtime.error", message, ...flags });
      event(threadId, { type: "turn.completed", ok: false, stopReason: stopReason ?? null });
    },
    complete: (threadId: string, text = "Inbox swept.") => {
      event(threadId, { type: "item.completed", itemType: "assistant_text", text });
      event(threadId, { type: "turn.completed", ok: true });
    },
  };
}

describe("why a routine run did not work, as the workspace reports it", () => {
  it("a run the computer was asleep or off through is missed, not timed out", async () => {
    const h = harness();
    h.routine();
    await h.advance(26 * HOUR);
    const missed = h.manager.listRuns().find((run) => run.status === "missed")!;
    expect(missed).toBeDefined();
    expect(h.reported(missed)).toEqual({ outcome: "failed", reason: "missed" });
  });

  it("a run a cap or used-up plan held back is held, not a failure", async () => {
    const h = harness({ held: () => "Not started: its bot reached its weekly cap" });
    const run = await h.start(h.routine().id);
    expect(h.run(run.id).status).toBe("missed");
    expect(h.reported(h.run(run.id))).toEqual({ outcome: "cancelled", reason: "held" });
  });

  it("a run stopped at its run limit timed out; it never reads as out of plan usage", async () => {
    const h = harness();
    const run = await h.start(h.routine({ timeoutMinutes: 5 }).id);
    await h.advance(6 * MINUTE);
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: "Stopped after reaching the 5-minute run limit" });
    expect(h.reported(h.run(run.id))).toEqual({ outcome: "failed", reason: "timeout" });
  });

  it("a run that waited a day on a question nobody answered is unanswered", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.event(run.threadId!, { type: "request.opened", requestId: "q1", requestType: "question", tool: "ask_user", summary: "Which inbox?" });
    await h.advance(25 * HOUR);
    expect(h.run(run.id).status).toBe("failed");
    expect(h.reported(h.run(run.id))).toEqual({ outcome: "failed", reason: "unanswered" });
  });

  it("a script that failed is the script's failure, whatever its words", async () => {
    const h = harness({ checks: { check: async () => ({ run: { key: "prb-k", prompt: "p", post: { error: "The script stopped with exit code 6: curl: (6) Could not resolve host: shop.example" } } }), release: () => {}, settled: () => {} }, postReply: () => {} });
    h.manager.create({ name: "Prices", prompt: "p", botId: "b", schedule: { type: "interval", everyMinutes: 60, anchorAt: START + HOUR }, probe: { kind: "script", url: "", command: "report" } });
    await h.advance(3 * HOUR);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const run = h.manager.listRuns().find((one) => one.status === "failed")!;
    expect(run).toBeDefined();
    expect(h.reported(run)).toEqual({ outcome: "failed", reason: "script" });
  });
});

describe("a routine whose AI was not ready to start", () => {
  const NOT_READY = "Codex app-server exited before it was ready";

  it("starts once more a minute later, quietly, and completes", async () => {
    const h = harness();
    h.dispatchFails(NOT_READY);
    const run = await h.start(h.routine().id);
    expect(h.run(run.id)).toMatchObject({ status: "queued", retried: "provider" });
    expect(h.failed).toEqual([]);
    expect(h.alerts).toEqual([]);
    h.dispatchFails(null);
    await h.advance(61 * SECOND);
    expect(h.started).toHaveLength(2);
    h.complete(h.run(run.id).threadId!);
    expect(h.run(run.id).status).toBe("completed");
  });

  it("fails as not ready when the second start fails too", async () => {
    const h = harness();
    h.dispatchFails(NOT_READY);
    const run = await h.start(h.routine().id);
    await h.advance(61 * SECOND);
    expect(h.run(run.id)).toMatchObject({ status: "failed", failedFor: "not_ready" });
    expect(h.reported(h.run(run.id))).toEqual({ outcome: "failed", reason: "not_ready" });
  });
});

describe("a routine whose AI's sign-in lapsed mid-run", () => {
  const EXPIRED = "API Error: 401 OAuth token has expired. Please obtain a new token or refresh your existing token.";

  it("starts once more a minute later without telling the owner, and completes when the sign-in renewed", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.fail(run.threadId!, EXPIRED);
    expect(h.run(run.id)).toMatchObject({ status: "queued", retried: "provider" });
    expect(h.failed).toEqual([]);
    expect(h.alerts).toEqual([]);
    await h.advance(61 * SECOND);
    h.complete(h.run(run.id).threadId!);
    expect(h.run(run.id).status).toBe("completed");
  });

  it("still tells the owner once when the second start is refused too", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.fail(run.threadId!, EXPIRED);
    await h.advance(61 * SECOND);
    h.fail(h.run(run.id).threadId!, EXPIRED);
    expect(h.run(run.id).status).toBe("failed");
    expect(h.alerts).toEqual([{ detail: "This bot's AI is signed out. Sign in again in Settings → Models." }]);
    expect(h.reported(h.run(run.id))).toEqual({ outcome: "failed", reason: "auth" });
  });
});

describe("a routine with nothing to report", () => {
  it("completes when its AI did the run's work and then said nothing", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.event(run.threadId!, { type: "item.started", itemType: "tool", itemId: "t1", title: "search mail" });
    h.event(run.threadId!, { type: "item.completed", itemType: "tool", itemId: "t1", ok: true } as EventBody);
    h.fail(run.threadId!, "OpenCode finished without replying.", { stopReason: "empty_turn" });
    expect(h.run(run.id)).toMatchObject({ status: "completed" });
    expect(h.failed).toEqual([]);
    expect(h.reported(h.run(run.id))).toEqual({ outcome: "ok", reason: undefined });
  });

  it("starts once more when its AI said nothing without doing anything, and completes quietly when it says nothing again", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.fail(run.threadId!, "OpenCode finished without replying.", { stopReason: "empty_turn" });
    expect(h.run(run.id)).toMatchObject({ status: "queued", retried: "provider" });
    await h.advance(16 * SECOND);
    expect(h.started).toHaveLength(2);
    h.fail(h.run(run.id).threadId!, "OpenCode finished without replying.", { stopReason: "empty_turn" });
    expect(h.run(run.id).status).toBe("completed");
    expect(h.failed).toEqual([]);
  });
});

describe("a routine's script that met a network blip", () => {
  const posting: RoutineProbe = { kind: "script", url: "", command: "report", post: true };
  const routine = { id: "r1", probe: posting, checks: ["probe"], prompt: "p" } as Routine;

  it("runs once more and posts what it printed then", async () => {
    const results: ScriptResult[] = [{ ok: false, error: "The script stopped with exit code 6: curl: (6) Could not resolve host: shop.example" }, { ok: true, output: "BTC 97,000" }];
    const pauses: number[] = [];
    const dir = mkdtempSync(join(tmpdir(), "dusk-routine-causes-")); dirs.push(dir);
    const probes = createRoutineProbes({ dataDir: dir, now: () => START, script: async () => results.shift()!, pause: async (ms) => { pauses.push(ms); } });
    expect((await probes.check(routine, { manual: false })).run?.post).toBe("BTC 97,000");
    expect(pauses).toEqual([15_000]);
  });

  it("never runs again a script that failed on its own", async () => {
    let runs = 0;
    const dir = mkdtempSync(join(tmpdir(), "dusk-routine-causes-")); dirs.push(dir);
    const probes = createRoutineProbes({ dataDir: dir, now: () => START, script: async () => { runs += 1; return { ok: false, error: "The script stopped with exit code 1: KeyError: 'price'" }; }, pause: async () => {} });
    expect((await probes.check(routine, { manual: false })).run?.post).toEqual({ error: "The script stopped with exit code 1: KeyError: 'price'" });
    expect(runs).toBe(1);
  });
});
