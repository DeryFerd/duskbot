import { describe, expect, it, vi } from "vitest";
import type { UsageReport, UsageTurn } from "../../../../shared/usage-signals.ts";
import { UNLINK_BATCH, createUsage, latencyBucket, memoryUsageStore, mongoUsageStore, noteKey, notesOnly, sweepExpired, ttlIndex, unlinkNotes, unlinkedDoc } from "./usage.ts";
import { focusRules, summarize, themesOf, type UsageAnswer } from "./usage-summary.ts";
import { dayOf } from "./events.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
let n = 0;
const turn = (patch: Partial<UsageTurn> = {}): UsageTurn => ({ id: `turn${String(++n).padStart(6, "0")}`, at: NOW - 3_600_000, engine: "claude", outcome: "ok", ms: 8000, tools: [], apps: [],
  category: "chat", from: "app", place: "desktop", room: false, ...patch });
const report = (patch: Partial<UsageReport>): UsageReport => ({ turns: [], runs: [], ...patch });

function setup(options: { optedOut?: string[] } = {}) {
  const store = memoryUsageStore(() => NOW), problems: string[] = [];
  const usage = createUsage({ store, now: () => NOW, optedOut: id => options.optedOut?.includes(id) ?? false,
    newProblem: group => problems.push(group.key) });
  return { usage, store, problems };
}

describe("where a note ran", () => {
  const frustration = { id: "frust00001", at: NOW - 1000, engine: "claude" as const, category: "email" as const, tools: [], apps: [], signals: ["retried" as const], retries: 1 };
  it("stamps notes with the place the report's turns ran and the workspace's version, and leaves turns bare", async () => {
    const { usage, store } = setup();
    await usage.ingest("acct_a", "ws_1", report({ turns: [turn({ place: "cloud" }), turn({ place: "cloud" }), turn()], frustrations: [frustration] }), { kind: "mac", version: "0.2.15" });
    const notes = await store.records("frustration", 0, NOW + 1, 10), turns = await store.records("turn", 0, NOW + 1, 10);
    expect(notes[0]!.ran).toEqual({ place: "cloud", os: "mac", version: "0.2.15" });
    expect(turns.every(record => !record.ran)).toBe(true);
  });
  it("falls back to the workspace kind, and drops a version that is not a version", async () => {
    const { usage, store } = setup();
    await usage.ingest("acct_a", "ws_1", report({ frustrations: [frustration] }), { kind: "vps", version: "<script>" });
    expect((await store.records("frustration", 0, NOW + 1, 10))[0]!.ran).toEqual({ place: "server", os: "vps" });
  });
});

describe("usage rollups", () => {
  it("counts each record once, even when a report arrives twice", async () => {
    const { usage, store } = setup();
    const r = report({ turns: [turn({ apps: ["gmail"], tools: ["app"], category: "email", outcome: "failed", reason: "auth" }), turn({ tools: ["browser"], category: "research" })],
      runs: [{ id: "run0000001", at: NOW - 1000, trigger: "schedule", outcome: "ok" }] });
    await usage.ingest("acct_a", "ws_1", r);
    await usage.ingest("acct_a", "ws_1", r);
    const [row] = await store.daily(dayOf(NOW), dayOf(NOW));
    expect(row!.c).toMatchObject({ turns: 2, ok: 1, failed: 1, "engine:claude": 2, "engine_fail:claude": 1, "category:email": 1, "category:research": 1, "app:gmail": 1, "app_fail:gmail": 1,
      "reason_app:gmail:auth": 1, "tool:browser": 1, runs: 1, "run:schedule": 1, people: 1 });
    expect(await store.people(dayOf(NOW), dayOf(NOW))).toEqual([{ day: dayOf(NOW), accountId: "acct_a", turns: 2, failed: 1, runs: 1, frustrations: 0, appTurns: 1 }]);
  });

  it("counts a second workspace's record with the same id on its own", async () => {
    const { usage, store } = setup();
    const t = turn();
    await usage.ingest("acct_a", "ws_1", report({ turns: [t] }));
    await usage.ingest("acct_a", "ws_2", report({ turns: [t] }));
    expect((await store.daily(dayOf(NOW), dayOf(NOW)))[0]!.c.turns).toBe(2);
  });

  it("drops an opted-out or unclaimed workspace, and keeps the notes of one that helps", async () => {
    const { usage, store, problems } = setup({ optedOut: ["acct_out"] });
    await usage.ingest("acct_out", "ws_1", report({ turns: [turn()] }));
    await usage.ingest(null, "ws_2", report({ turns: [turn()] }));
    expect(await store.daily(dayOf(NOW), dayOf(NOW))).toEqual([]);
    const f = { id: "frust00001", at: NOW - 1000, engine: "claude" as const, category: "email" as const, tools: ["app" as const], apps: ["gmail"], signals: ["retried" as const], retries: 2, summary: "bot kept failing in the email app." };
    const s = { id: "session001", at: NOW - 500, engine: "claude" as const, category: "coding" as const, tools: ["terminal" as const], apps: ["github"], turns: 18, minutes: 42, failed: 1,
      summary: "a long coding session with github; signing in took 2 tries." };
    await usage.ingest("acct_out", "ws_1", report({ sessions: [s] }));
    expect(await store.records("session", 0, NOW + 1, 10)).toEqual([]);
    await usage.ingest("acct_quiet", "ws_3", report({ frustrations: [f], sessions: [s], digests: [{ id: "digest0001", at: NOW - 1000, turns: 40, days: 4, summary: "they use it for email." }] }));
    const [stored] = await store.records("frustration", 0, NOW + 1, 10);
    expect((stored!.data as { summary?: string }).summary).toBe(f.summary);
    expect((await store.records("session", 0, NOW + 1, 10))[0]!.data).toEqual({ ...s, id: noteKey(s.id) });
    expect(await store.records("digest", 0, NOW + 1, 10)).toHaveLength(1);
    expect((await store.daily(dayOf(NOW), dayOf(NOW)))[0]!.c.sessions).toBe(1);
    expect(problems).toEqual(["claude|email|gmail"]);
    await usage.ingest("acct_b", "ws_4", report({ frustrations: [{ ...f, id: "frust00002" }] }));
    expect(problems).toHaveLength(1);
  });

  it("forgets an account's records", async () => {
    const { usage, store } = setup();
    await usage.ingest("acct_a", "ws_1", report({ turns: [turn()], snapshot: { bots: 2, rooms: 0, routines: 1, webhooks: 0, appEvents: 0, skills: 0 } }));
    await usage.forget("acct_a");
    expect(await store.records("turn", 0, NOW + 1, 10)).toEqual([]);
    expect(await store.snapshots()).toEqual([]);
    expect(await store.people(dayOf(NOW), dayOf(NOW))).toEqual([]);
  });

  it("buckets turn time", () => {
    expect(latencyBucket(1500)).toBe(0);
    expect(latencyBucket(45_000)).toBe(5);
    expect(latencyBucket(3_600_000)).toBe(9);
  });
});

describe("usage answer and focus", () => {
  async function answerFor(reports: Array<[string, UsageReport]>, adoption = { accounts: 20, bot: 15, routine: 5, connector: 4, phone: 2, cloud: 1 }) {
    const { usage, store } = setup();
    for (const [account, r] of reports) await usage.ingest(account, `ws_${account}`, r);
    const days = [dayOf(NOW - 86_400_000), dayOf(NOW)];
    return summarize({ days, daily: await store.daily(days[0]!, days[1]!), previousDaily: [], people: await store.people(days[0]!, days[1]!), previousPeople: 0,
      snapshots: await store.snapshots(), frustrations: await store.records("frustration", 0, NOW + 1, 100), digests: await store.records("digest", 0, NOW + 1, 100), adoption });
  }

  it("ranks categories, apps and failures with plain reasons", async () => {
    const turns = [
      ...Array.from({ length: 30 }, (_, i) => turn({ apps: ["gmail"], tools: ["app"], category: "email", outcome: i < 6 ? "failed" : "ok", reason: i < 6 ? "auth" : undefined })),
      ...Array.from({ length: 10 }, () => turn({ tools: ["browser"], category: "research", ms: 200_000 })),
    ];
    const a = await answerFor([["acct_a", report({ turns })]]);
    expect(a.categories[0]).toMatchObject({ key: "email", turns: 30, failed: 6 });
    expect(a.apps[0]).toMatchObject({ key: "gmail", turns: 30 });
    expect(a.failures.find(row => row.kind === "app" && row.key === "gmail")).toMatchObject({ failed: 6, reason: "auth", reasonWords: "sign-in expired or was refused" });
    expect(a.totals).toMatchObject({ turns: 40, people: 1 });
    expect(a.focus[0]!.text).toBe("gmail is the #1 app, but 20% of its turns fail (mostly sign-in expired or was refused): fix that first.");
    expect(a.focus.length).toBeGreaterThanOrEqual(1);
    expect(a.focus.length).toBeLessThanOrEqual(5);
  });

  it("says when routines are made but rarely run twice, and where adoption drops", async () => {
    const snap = { bots: 1, rooms: 0, routines: 1, webhooks: 0, appEvents: 0, skills: 0 };
    const reports: Array<[string, UsageReport]> = ["a", "b", "c", "d", "e"].map((id, i) => [`acct_${id}`, report({ turns: [turn()], snapshot: snap,
      runs: i === 0 ? [{ id: "run0000001", at: NOW - 5000, trigger: "schedule", outcome: "ok" }, { id: "run0000002", at: NOW - 4000, trigger: "schedule", outcome: "ok" }] : [] })]);
    const a = await answerFor(reports);
    expect(a.routines).toMatchObject({ peopleWithRoutines: 5, peopleRan: 1, peopleRanTwice: 1 });
    const texts = a.focus.map(item => item.text);
    expect(texts).toContain("people make routines, but only 20% of them had one run twice: look at routine reliability.");
    expect(texts).toContain("only 13% of people with a bot use it on their phone: make that easier to find.");
  });

  it("groups frustrations by problem and digests by theme, and feeds focus", async () => {
    const frustration = (i: number) => ({ id: `frust0000${i}`, at: NOW - 1000, engine: "codex" as const, category: "coding" as const, tools: ["terminal" as const], apps: [], signals: ["stopped" as const],
      retries: 0, summary: `the bot kept breaking the build while fixing a test, attempt ${"abc"[i]}.` });
    const digests = [0, 1, 2].map(i => ({ id: `digest000${i}`, at: NOW - 1000, turns: 40, days: 4, summary: i < 2 ? "they use it for email replies; slow replies are painful." : "mostly coding help." }));
    const a = await answerFor([["acct_a", report({ frustrations: [0, 1, 2].map(frustration), digests })]]);
    expect(a.frustration.groups[0]).toMatchObject({ key: "codex|coding|terminal", count: 3 });
    expect(a.frustration.groups[0]!.examples).toHaveLength(3);
    expect(a.themes.find(theme => theme.key === "email")).toMatchObject({ count: 2 });
    expect(a.focus.some(item => item.id === "problem:codex|coding|terminal")).toBe(true);
    expect(a.focus.some(item => item.id === "theme:slow")).toBe(true);
  });

  it("counts setup as confusing only when a note says it hurt, not when people set something up", () => {
    const notes = ["they set up a telegram bot and a daily routine.", "the bot kept setup files organized.", "the chats show little friction, so pain points are unclear.",
      "what is painful is unclear setup and a repeated welcome loop.", "it is painful when slack setup stalls.", "the app showed a confusing connection dialog."];
    expect(themesOf(notes).find(theme => theme.key === "confusing")?.count).toBe(3);
  });

  it("writes nothing for an empty window", () => {
    const empty = { totals: { turns: 0, failRate: null, p90Ms: null }, apps: [], failures: [], frustration: { groups: [] }, routines: { peopleWithRoutines: 0, runs: 0, failed: 0 },
      adoption: [], categories: [], themes: [], people: { topShare: null } } as unknown as UsageAnswer;
    expect(focusRules(empty)).toEqual([]);
    expect(themesOf([])).toEqual([]);
  });
});

describe("session notes kept apart from people", () => {
  const f = { id: "frust00001", at: NOW - 1000, engine: "claude" as const, category: "email" as const, tools: ["app" as const], apps: ["gmail"], signals: ["retried" as const], retries: 2, summary: "gmail would not connect." };
  it("keeps notes only with a yes, under a hashed id with no account or workspace, while the account's day still counts them", async () => {
    const store = memoryUsageStore(() => NOW);
    const usage = createUsage({ store, now: () => NOW, optedOut: () => false, notesOn: id => id === "acct_yes", isTest: (_, ws) => ws.startsWith("qatest") });
    await usage.ingest("acct_no", "ws_1", report({ frustrations: [f] }));
    expect(await store.records("frustration", 0, NOW + 1, 10)).toEqual([]);
    await usage.ingest("acct_yes", "ws_2", report({ turns: [turn()], frustrations: [f] }));
    await usage.ingest("acct_yes", "qatest_ws", report({ frustrations: [{ ...f, id: "frust00002" }] }));
    const notes = await store.records("frustration", 0, NOW + 1, 10);
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note).toMatchObject({ accountId: "", workspaceId: "" });
      expect(note.id).toBe((note.data as { id: string }).id);
      expect(JSON.stringify(note)).not.toMatch(/acct_yes|ws_2|frust0000/);
    }
    expect(notes.filter(note => note.test)).toHaveLength(1);
    expect((await store.records("turn", 0, NOW + 1, 10))[0]).toMatchObject({ accountId: "acct_yes", workspaceId: "ws_2" });
    expect((await store.people(dayOf(NOW), dayOf(NOW)))[0]).toMatchObject({ accountId: "acct_yes", frustrations: 2, turns: 1 });
    await usage.ingest("acct_yes", "ws_2", report({ frustrations: [f] }));
    expect(await store.records("frustration", 0, NOW + 1, 10)).toHaveLength(2);
  });
  it("deletes a workspace's notes by the ids it sent and, when asked, its records; another workspace's stay", async () => {
    const store = memoryUsageStore(() => NOW), usage = createUsage({ store, now: () => NOW, optedOut: () => false, notesOn: () => true });
    await usage.ingest("acct_a", "ws_1", report({ turns: [turn()], frustrations: [f] }));
    await usage.ingest("acct_a", "ws_2", report({ turns: [turn()], frustrations: [{ ...f, id: "frust00002" }] }));
    await usage.forgetShared("ws_1", { notes: ["frust00001"], records: true });
    expect((await store.records("frustration", 0, NOW + 1, 10)).map(note => note.id)).toEqual([noteKey("frust00002")]);
    expect((await store.records("turn", 0, NOW + 1, 10)).map(record => record.workspaceId)).toEqual(["ws_2"]);
  });
  it("strips a report down to its notes", () => {
    expect(notesOnly(report({ turns: [turn()], frustrations: [f], snapshot: { bots: 1, rooms: 0, routines: 0, webhooks: 0, appEvents: 0, skills: 0 } }))).toEqual({ turns: [], runs: [], frustrations: [f] });
  });
});

describe("moving stored notes away from their account", () => {
  type Doc = Record<string, unknown> & { _id: string };
  function collection(docs: Doc[]) {
    const all = new Map(docs.map(doc => [doc._id, doc]));
    const matches = (doc: Doc) => ["frustration", "session", "digest"].includes(doc.kind as string) && ("accountId" in doc || "workspaceId" in doc);
    return {
      all,
      find: () => ({ limit: (n: number) => ({ toArray: async () => [...all.values()].filter(matches).slice(0, n) }) }),
      insertMany: async (list: Doc[]) => {
        const writeErrors: Array<{ index: number; code: number }> = [];
        list.forEach((doc, index) => { if (all.has(doc._id)) writeErrors.push({ index, code: 11000 }); else all.set(doc._id, doc); });
        if (writeErrors.length) throw Object.assign(new Error("dup"), { writeErrors });
      },
      deleteMany: async (filter: { _id: { $in: string[] } }) => { for (const id of filter._id.$in) all.delete(id); },
    };
  }
  const note = (n: number): Doc => ({ _id: `ws_1:frust${String(n).padStart(5, "0")}`, kind: "frustration", at: new Date(NOW), accountId: "acct_a", workspaceId: "ws_1", ran: { place: "desktop" },
    data: { id: `frust${String(n).padStart(5, "0")}`, at: NOW, summary: "x" } });
  it("re-keys every note by its hashed id without account or workspace, in batches, and leaves turns alone", async () => {
    const turnDoc: Doc = { _id: "ws_1:turn000001", kind: "turn", at: new Date(NOW), accountId: "acct_a", workspaceId: "ws_1", data: { id: "turn000001" } };
    const docs = [...Array.from({ length: UNLINK_BATCH + 3 }, (_, i) => note(i)), turnDoc];
    const events = collection(docs);
    expect(await unlinkNotes(events as never)).toBe(UNLINK_BATCH + 3);
    expect(events.all.get(turnDoc._id)).toEqual(turnDoc);
    const moved = events.all.get(noteKey("frust00001"))!;
    expect(moved).toEqual({ _id: noteKey("frust00001"), kind: "frustration", at: new Date(NOW), ran: { place: "desktop" }, data: { id: noteKey("frust00001"), at: NOW, summary: "x" } });
    expect([...events.all.values()].filter(doc => doc.kind === "frustration").every(doc => !("accountId" in doc) && !("workspaceId" in doc))).toBe(true);
    expect(await unlinkNotes(events as never)).toBe(0);
  });
  it("finishes a run that stopped after inserting but before deleting", async () => {
    const old = note(7), events = collection([old, { ...unlinkedDoc(old as never) } as Doc]);
    expect(await unlinkNotes(events as never)).toBe(1);
    expect([...events.all.keys()]).toEqual([noteKey("frust00007")]);
  });
  it("changes the TTL of an index made with another one, and leaves a matching one alone", async () => {
    const commands: unknown[] = [];
    const run = async (command: Record<string, unknown>) => { commands.push(command); };
    const events = (expire: number) => ({ indexes: async () => [{ key: { _id: 1 } }, { key: { at: 1 }, expireAfterSeconds: expire }], collectionName: "usage_events" });
    expect(await ttlIndex(events(90 * 86_400) as never, 30 * 86_400, run)).toBe("changed");
    expect(await ttlIndex(events(30 * 86_400) as never, 30 * 86_400, run)).toBe("ok");
    expect(await ttlIndex({ indexes: async () => { throw Object.assign(new Error("ns"), { codeName: "NamespaceNotFound" }); } } as never, 30 * 86_400, run)).toBe("ok");
    expect(commands).toEqual([{ collMod: "usage_events", index: { keyPattern: { at: 1 }, expireAfterSeconds: 30 * 86_400 } }]);
  });

  // the service's mongo user is readWrite: collMod (dbAdmin) is refused with code 13, and on some setups dropIndex too
  const unauthorized = () => Object.assign(new Error("not authorized"), { code: 13, codeName: "Unauthorized" });
  type Spec = { key: Record<string, number>; name?: string; expireAfterSeconds?: number };
  function fakeDb({ dropRefused, docs = [] }: { dropRefused: boolean; docs?: Array<{ _id: string; at: Date }> }) {
    const indexes = new Map<string, Spec[]>([["usage_events", [{ key: { _id: 1 }, name: "_id_" }, { key: { at: 1 }, name: "at_1", expireAfterSeconds: 90 * 86_400 }]]]);
    const rows = new Map(docs.map(doc => [doc._id, doc]));
    const nameOf = (key: Record<string, number>) => Object.entries(key).map(([field, dir]) => `${field}_${dir}`).join("_");
    const make = (spec: Spec, list: Spec[]) => {
      const same = list.find(item => nameOf(item.key) === nameOf(spec.key));
      if (same && same.expireAfterSeconds !== spec.expireAfterSeconds) throw Object.assign(new Error("conflict"), { code: 85, codeName: "IndexOptionsConflict" });
      if (!same) list.push({ ...spec, name: nameOf(spec.key) });
    };
    const db = {
      command: async () => { throw unauthorized(); },
      collection: (name: string) => {
        const list = indexes.get(name) ?? (indexes.set(name, []), indexes.get(name)!);
        return {
          collectionName: name, db: undefined as unknown,
          indexes: async () => list.map(spec => ({ ...spec })),
          createIndexes: async (specs: Spec[]) => { for (const spec of specs) make(spec, list); },
          createIndex: async (key: Record<string, number>, options: { expireAfterSeconds?: number }) => make({ key, ...options }, list),
          dropIndex: async (index: string) => { if (dropRefused) throw unauthorized(); list.splice(list.findIndex(spec => spec.name === index), 1); },
          find: (filter: { at?: { $lt: Date } }) => ({ limit: (n: number) => ({ toArray: async () =>
            name !== "usage_events" ? [] : [...rows.values()].filter(doc => filter.at ? doc.at < filter.at.$lt : false).slice(0, n) }) }),
          deleteMany: vi.fn(async (filter: { _id: { $in: string[] } }) => { let deletedCount = 0; for (const id of filter._id.$in) if (rows.delete(id)) deletedCount++; return { deletedCount }; }),
          insertMany: async () => {},
        };
      },
    };
    return { db, indexes, rows };
  }
  it("starts when collMod is refused, and makes the TTL again with dropIndex and createIndex", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { db, indexes } = fakeDb({ dropRefused: false });
      await expect(mongoUsageStore(db as never)).resolves.toBeTruthy();
      expect(indexes.get("usage_events")!.find(spec => spec.name === "at_1")!.expireAfterSeconds).toBe(30 * 86_400);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); log.mockRestore(); }
  });
  it("starts when collMod and dropIndex are both refused, warns once and deletes records past 30 days itself", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const old = (i: number) => ({ _id: `old${i}`, at: new Date(Date.now() - 31 * 86_400_000) }), fresh = { _id: "fresh", at: new Date(Date.now() - 86_400_000) };
      const { db, indexes, rows } = fakeDb({ dropRefused: true, docs: [old(1), old(2), old(3), fresh] });
      await expect(mongoUsageStore(db as never, { batch: 2 })).resolves.toBeTruthy();
      // the 90 day index stays (it cannot be changed) and the other indexes are still made
      expect(indexes.get("usage_events")!.map(spec => spec.name)).toEqual(["_id_", "at_1", "kind_1_at_-1", "accountId_1", "workspaceId_1"]);
      await vi.waitFor(() => expect([...rows.keys()]).toEqual(["fresh"]));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("deleted hourly");
    } finally { warn.mockRestore(); }
  });
  it("sweeps in capped batches and stops when nothing is left", async () => {
    const at = new Date(NOW - 40 * 86_400_000), rows = new Map(Array.from({ length: 7 }, (_, i) => [`r${i}`, { _id: `r${i}`, at }]));
    const events = {
      find: (filter: { at: { $lt: Date } }) => ({ limit: (n: number) => ({ toArray: async () => [...rows.values()].filter(doc => doc.at < filter.at.$lt).slice(0, n) }) }),
      deleteMany: async (filter: { _id: { $in: string[] } }) => { for (const id of filter._id.$in) rows.delete(id); return { deletedCount: filter._id.$in.length }; },
    };
    expect(await sweepExpired(events as never, 30 * 86_400, { batch: 2, maxBatches: 3, now: () => NOW })).toBe(6);
    expect(await sweepExpired(events as never, 30 * 86_400, { batch: 2, maxBatches: 3, now: () => NOW })).toBe(1);
    expect(await sweepExpired(events as never, 30 * 86_400, { batch: 2, maxBatches: 3, now: () => NOW })).toBe(0);
  });
});
