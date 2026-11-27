import { describe, expect, it } from "vitest";
import { freshSessionDue, freshSessionStart, parseCompactAt, parseFreshSession } from "./fresh-session.ts";
import { FRESH_SESSION_FRAME, selectReplay } from "./context-rebuild.ts";

const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);

describe("freshSessionDue", () => {
  it("never without a policy or a message before", () => {
    expect(freshSessionDue(undefined, at("2026-11-26T10:00:00Z"), at("2026-11-28T10:00:00Z"), "UTC")).toBeNull();
    expect(freshSessionDue({ every: "day" }, undefined, at("2026-11-28T10:00:00Z"), "UTC")).toBeNull();
  });

  it("every day: the first message from 4 am in the person's time zone, not at midnight", () => {
    const policy = { every: "day" } as const;
    expect(freshSessionDue(policy, at("2026-11-26T22:00:00Z"), at("2026-11-27T01:30:00Z"), "UTC")).toBeNull();
    expect(freshSessionDue(policy, at("2026-11-27T01:30:00Z"), at("2026-11-27T04:10:00Z"), "UTC")).toBe("day");
    expect(freshSessionDue(policy, at("2026-11-27T05:00:00Z"), at("2026-11-27T23:00:00Z"), "UTC")).toBeNull();
    // 22:00 and 05:00 UTC are 03:30 and 10:30 in Kolkata: a new day there, not in UTC
    expect(freshSessionDue(policy, at("2026-11-26T22:00:00Z"), at("2026-11-27T05:00:00Z"), "Asia/Kolkata")).toBe("day");
    expect(freshSessionDue(policy, at("2026-11-26T22:00:00Z"), at("2026-11-27T05:00:00Z"), "Not/AZone")).toBe("day");
  });

  it("after idle hours: counted from the person's previous message", () => {
    const policy = { idleHours: 6 };
    const before = at("2026-11-27T08:00:00Z");
    expect(freshSessionDue(policy, before, before + 6 * HOUR - 1, "UTC")).toBeNull();
    expect(freshSessionDue(policy, before, before + 6 * HOUR, "UTC")).toBe("idle");
  });
});

describe("freshSessionStart", () => {
  const rows = [
    { id: "u1", role: "user", at: 1, kind: "text" },
    { id: "b1", role: "bot", at: 2, kind: "text" },
    { id: "a1", role: "bot", at: 3, kind: "activity" },
    { id: "p1", role: "user", at: 4, kind: "text", peerAsk: { name: "Rivet" } },
    { id: "u2", role: "user", at: 9, kind: "text" },
  ];
  const inContext = (row: { kind: string }) => row.kind === "text";

  it("reads when the person last wrote and the last line the model read", () => {
    expect(freshSessionStart(rows, "u2", inContext)).toEqual({ previousAt: 1, foldedThroughId: "p1", started: false });
  });

  it("knows a fresh session already starting at the message (a retried turn)", () => {
    const retried = [...rows, { id: "c1", role: "bot", at: 10, kind: "compaction", compaction: { fresh: "idle", firstKeptId: "u2" } }];
    expect(freshSessionStart(retried, "u2", inContext).started).toBe(true);
  });

  it("has nothing to start over in a chat's first message", () => {
    expect(freshSessionStart(rows, "u1", inContext)).toEqual({ started: false });
  });
});

describe("the fresh session's replay", () => {
  it("drops everything before the person's message and gives the model no summary, only the session_search pointer", () => {
    const history = [
      { id: "u1", role: "user" as const, text: "my locker code is 4471" },
      { id: "b1", role: "assistant" as const, text: "Noted." },
      { id: "u2", role: "user" as const, text: "good morning" },
      { id: "c1", role: "assistant" as const, text: "" },
    ];
    const replay = selectReplay(history, {
      excludedIds: new Set(["u2"]),
      compaction: { id: "c1", firstKeptId: "u2", foldedThroughId: "b1", summary: "", tokensBefore: 0, by: "harness", fresh: "day" },
    });
    expect(replay.transcript).toEqual([{ id: "c1", role: "assistant", text: FRESH_SESSION_FRAME }]);
    expect(JSON.stringify(replay.transcript)).not.toContain("4471");
    expect(FRESH_SESSION_FRAME).toContain("session_search");
  });
});

describe("request bodies", () => {
  it("takes the policies the settings offer and refuses anything else", () => {
    expect(parseFreshSession(undefined)).toBeUndefined();
    expect(parseFreshSession(null)).toBeNull();
    expect(parseFreshSession({ every: "day" })).toEqual({ every: "day" });
    expect(parseFreshSession({ idleHours: 24 })).toEqual({ idleHours: 24 });
    for (const bad of [{}, { every: "week" }, { idleHours: 0 }, { idleHours: 10_000 }, { idleHours: 6, every: "day" }, "daily", [1]]) {
      expect(parseFreshSession(bad)).toHaveProperty("error");
    }
    expect(parseCompactAt(0.5)).toBe(0.5);
    expect(parseCompactAt(null)).toBeNull();
    for (const bad of [0.1, 0.95, 80, "0.5", Number.NaN]) expect(parseCompactAt(bad)).toHaveProperty("error");
  });
});
