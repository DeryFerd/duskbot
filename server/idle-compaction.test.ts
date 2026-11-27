import { describe, expect, it } from "vitest";
import { conversationHold, type QuietDeps } from "./host/warm-summary-host.ts";
import { createIdleCompaction, IDLE_COMPACT_PER_SWEEP, idleCompactHours, type IdleCandidate } from "./idle-compaction.ts";
import type { Routine, RoutineRun } from "./routines.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 26, 20, 0);

function fixture(options: { candidates?: IdleCandidate[]; hours?: number; hold?: (c: IdleCandidate) => string | null; compact?: (c: IdleCandidate, signal: AbortSignal) => Promise<boolean> } = {}) {
  let now = NOW;
  const compacted: string[] = [];
  const asked: number[] = [];
  const idle = createIdleCompaction({
    now: () => now,
    hours: () => options.hours ?? 6,
    candidates: (askedBefore) => { asked.push(askedBefore); return options.candidates ?? []; },
    hold: options.hold ?? (() => null),
    compact: options.compact ?? (async (c) => { compacted.push(c.threadId); return true; }),
    after: () => ({ cancel() {} }),
  });
  return { idle, compacted, asked, advance: (ms: number) => { now += ms; } };
}

const chat = (threadId: string, hoursAgo: number, extra: Partial<IdleCandidate> = {}): IdleCandidate =>
  ({ botId: "bot", threadId, askedAt: NOW - hoursAgo * HOUR, ...extra });

describe("idle compaction", () => {
  it("summarizes a chat the person left 6 hours ago, not one they wrote in 5 hours ago", async () => {
    const f = fixture({ candidates: [chat("left", 6), chat("recent", 5)] });
    expect(await f.idle.sweep()).toBe(1);
    expect(f.compacted).toEqual(["left"]);
    // only threads the person last wrote in before the cutoff are asked for
    expect(f.asked).toEqual([NOW - 6 * HOUR]);
  });

  it("does it once per absence, and again after the person's next message and absence", async () => {
    const candidates = [chat("a", 7)];
    const f = fixture({ candidates });
    await f.idle.sweep();
    await f.idle.sweep();
    expect(f.compacted).toEqual(["a"]);
    candidates[0] = { ...candidates[0]!, askedAt: NOW + HOUR };
    f.advance(8 * HOUR);
    await f.idle.sweep();
    expect(f.compacted).toEqual(["a", "a"]);
  });

  it("skips a chat already summarized since the person last wrote (a fold or the warm summary)", async () => {
    const f = fixture({ candidates: [chat("folded", 8, { compactedAt: NOW - 7 * HOUR }), chat("older-fold", 8, { compactedAt: NOW - 9 * HOUR })] });
    await f.idle.sweep();
    expect(f.compacted).toEqual(["older-fold"]);
  });

  it("leaves chats left more than three days ago alone, so a restart never summarizes every old chat at once", async () => {
    const f = fixture({ candidates: [chat("week-old", 24 * 7), chat("yesterday", 30)] });
    await f.idle.sweep();
    expect(f.compacted).toEqual(["yesterday"]);
  });

  it("does at most a few per sweep, oldest absence first, and the rest on the next sweep", async () => {
    const candidates = Array.from({ length: IDLE_COMPACT_PER_SWEEP + 2 }, (_, i) => chat(`c${i}`, 7 + i));
    const f = fixture({ candidates });
    await f.idle.sweep();
    expect(f.compacted).toEqual(["c4", "c3", "c2"]);
    await f.idle.sweep();
    expect(f.compacted).toEqual(["c4", "c3", "c2", "c1", "c0"]);
  });

  it("is off at 0 hours", async () => {
    const f = fixture({ candidates: [chat("a", 50)], hours: 0 });
    expect(await f.idle.sweep()).toBe(0);
    expect(f.asked).toEqual([]);
  });

  it("never runs while held, and runs on the sweep after the hold is gone", async () => {
    let held: string | null = "the bot is busy";
    const f = fixture({ candidates: [chat("a", 7)], hold: () => held });
    await f.idle.sweep();
    expect(f.compacted).toEqual([]);
    held = null;
    await f.idle.sweep();
    expect(f.compacted).toEqual(["a"]);
  });

  it("drops a summary when a turn starts in that chat, and tries again later", async () => {
    let release!: () => void;
    let calls = 0;
    const f = fixture({
      candidates: [chat("a", 7)],
      compact: (_c, signal) => {
        calls++;
        if (calls > 1) return Promise.resolve(true);
        return new Promise<boolean>((resolve, reject) => {
          release = () => resolve(true);
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    const first = f.idle.sweep();
    await Promise.resolve();
    expect(f.idle.running()).toBe("a");
    f.idle.turnStarted("a");
    await first;
    expect(f.idle.running()).toBe(null);
    // a routine's turn left askedAt as it was: the absence is still on, so the next quiet sweep summarizes it
    await f.idle.sweep();
    expect(calls).toBe(2);
    release?.();
  });

  it("does not retry a chat whose summary failed, or was under the size floor", async () => {
    let calls = 0;
    const f = fixture({ candidates: [chat("small", 7), chat("broken", 8)], compact: async (c) => { calls++; if (c.threadId === "broken") throw new Error("helper down"); return false; } });
    expect(await f.idle.sweep()).toBe(0);
    await f.idle.sweep();
    expect(calls).toBe(2);
  });
});

describe("what holds a background summary", () => {
  const routine = { id: "r1", botId: "bot", name: "Brief", enabled: true, schedule: "0 9 * * *", nextRunAt: NOW + 3 * HOUR } as unknown as Routine;
  const quiet = (over: Partial<QuietDeps> = {}): QuietDeps => ({
    busy: () => false, memoryShort: () => false, queued: () => false,
    coordinator: { activeDirect: () => false, awaitingTeammateThreads: () => new Set() },
    waits: () => null, routines: () => ({ listRoutines: () => [routine], listRuns: () => [] }), ...over,
  });
  const target = { botId: "bot", threadId: "t" };

  it("is nothing when the bot is quiet", () => {
    expect(conversationHold(quiet(), target, NOW)).toBe(null);
  });

  it("holds mid-turn: a turn running or being set up in the chat, or the bot busy elsewhere", () => {
    expect(conversationHold(quiet({ busy: () => true }), target, NOW)).toMatchObject({ reason: "the bot is busy", retry: true });
  });

  it("holds while one of the bot's routines runs, and when one is about to", () => {
    const running = { id: "run1", routineId: "r1", botId: "bot", status: "running", startedAt: NOW - 60_000 } as unknown as RoutineRun;
    expect(conversationHold(quiet({ routines: () => ({ listRoutines: () => [routine], listRuns: () => [running] }) }), target, NOW)?.reason).toMatch(/routine/);
    const soon = { ...routine, nextRunAt: NOW + 60_000 } as Routine;
    expect(conversationHold(quiet({ routines: () => ({ listRoutines: () => [soon], listRuns: () => [] }) }), target, NOW)?.reason).toMatch(/routine/);
  });

  it("holds while a message waits in the queue or a teammate works on the chat's request", () => {
    expect(conversationHold(quiet({ queued: () => true }), target, NOW)?.reason).toMatch(/waiting/);
    expect(conversationHold(quiet({ coordinator: { activeDirect: () => true, awaitingTeammateThreads: () => new Set() } }), target, NOW)?.reason).toMatch(/teammate/);
  });
});

describe("idleCompactHours", () => {
  it("reads the setting, lets DUSK_IDLE_COMPACT_HOURS win, and defaults to 6", () => {
    expect(idleCompactHours(undefined, undefined)).toBe(6);
    expect(idleCompactHours(3, undefined)).toBe(3);
    expect(idleCompactHours(3, "0")).toBe(0);
    expect(idleCompactHours(0, "")).toBe(0);
    expect(idleCompactHours(undefined, "nonsense")).toBe(6);
  });
});
