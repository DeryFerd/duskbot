import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE_RETENTION_DAYS, MAX_FORGET_NOTES } from "../shared/usage-signals.ts";
import { createSharedLog } from "./usage-shared.ts";

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 25, 12);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const file = () => { const dir = mkdtempSync(join(tmpdir(), "usage-shared-")); dirs.push(dir); return join(dir, "usage-shared.json"); };
const note = (id: string, at = NOW - 1000, summary?: string) => ({ id, at, engine: "claude" as const, category: "email" as const, tools: [], apps: [], signals: ["retried" as const], retries: 1, ...(summary ? { summary } : {}) });

describe("what this workspace shared", () => {
  it("lists the notes as sent, newest first, and the kinds of records with counts, across a restart, readable only by the owner", () => {
    let now = NOW;
    const path = file(), log = createSharedLog({ file: path, now: () => now });
    log.sent({ turns: [{} as never, {} as never], runs: [{} as never], frustrations: [note("frust00001", NOW - 5000, "gmail would not connect.")],
      signals: [{ id: "s1", at: NOW, name: "engine_sign_in", props: {} }], snapshot: { bots: 1, rooms: 0, routines: 0, webhooks: 0, appEvents: 0, skills: 0 } });
    log.sentNotes({ sessions: [{ id: "session001", at: NOW - 100, engine: "codex", category: "coding", tools: [], apps: [], turns: 20, minutes: 40, failed: 0 }] });
    now += 60_000;
    log.sent({ turns: [{} as never], runs: [] });
    const again = createSharedLog({ file: path, now: () => now }).list();
    expect(again.notes).toEqual([{ id: "session001", kind: "big", at: NOW - 100, text: null }, { id: "frust00001", kind: "bad", at: NOW - 5000, text: "gmail would not connect." }]);
    expect(again.counts).toEqual([{ kind: "turns", count: 3, last: now }, { kind: "runs", count: 1, last: NOW }, { kind: "setup", count: 1, last: NOW }, { kind: "events", count: 1, last: NOW, names: ["engine_sign_in"] }]);
    expect(again.removing).toBe(false);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("lets go of what the account service no longer keeps either", () => {
    let now = NOW;
    const log = createSharedLog({ now: () => now });
    log.sent({ turns: [{} as never], runs: [], digests: [{ id: "digest0001", at: NOW, turns: 40, days: 4, summary: "mostly email." }] });
    now += (USAGE_RETENTION_DAYS + 1) * DAY;
    expect(log.list()).toEqual({ notes: [], counts: [], removing: false });
  });
  it("clears the list at once and owes the account service the delete, in batches, until each gets through", () => {
    const path = file(), log = createSharedLog({ file: path, now: () => NOW });
    log.sent({ turns: [{} as never], runs: [], frustrations: Array.from({ length: MAX_FORGET_NOTES + 5 }, (_, i) => note(`frust${String(i).padStart(5, "0")}`)) });
    log.forget({ records: false });
    expect(log.list()).toMatchObject({ notes: [], removing: true });
    expect(log.list().counts).toHaveLength(1);
    const first = log.forgetting()!;
    expect(first.notes).toHaveLength(MAX_FORGET_NOTES); expect(first.records).toBe(false);
    log.forgotten(first);
    log.forget({ records: true });
    expect(log.list().counts).toEqual([]);
    const reopened = createSharedLog({ file: path, now: () => NOW });
    const second = reopened.forgetting()!;
    expect(second).toEqual({ notes: expect.any(Array), records: true });
    expect(second.notes).toHaveLength(5);
    reopened.forgotten(second);
    expect(reopened.forgetting()).toBeNull();
    expect(reopened.list().removing).toBe(false);
  });
});
