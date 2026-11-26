// What people use Dusk for: the usage section of workspace reports (shared/usage-signals.ts), kept raw for
// USAGE_RETENTION_DAYS and rolled up per day into counts that are kept. Records hold words, counts and times, plus the
// scrubbed summaries a workspace wrote; never message content.
// Security: a session note is stored under noteKey(its id) with no account and no workspace, so nobody here can tell
// whose it is; only the workspace that wrote it knows the id, and that is how it asks for it to be deleted.
import { createHash } from "node:crypto";
import type { Collection, Db } from "mongodb";
import { USAGE_RETENTION_DAYS, type UsageForget, USAGE_REASONS, type UsagePlace, type UsageDigest, type UsageFrustration, type UsageReport, type UsageRun, type UsageSession, type UsageSignal, type UsageSnapshot, type UsageTurn } from "../../../../shared/usage-signals.ts";
import { DAY_MS, dayOf } from "./events.ts";

export { USAGE_RETENTION_DAYS };
const NOTE_KINDS = ["frustration", "session", "digest"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const isNoteKind = (kind: string): kind is NoteKind => (NOTE_KINDS as readonly string[]).includes(kind);
/** the stored id of a note: a hash of the id only its workspace knows */
export const noteKey = (id: string) => `note_${createHash("sha256").update(`dusk-note|${id}`).digest("base64url").slice(0, 32)}`;
/** per person per day counts feed the power-user and active-day views; kept longer than raw records, not forever */
export const PEOPLE_RETENTION_DAYS = 400;
/** turn time buckets in seconds; a percentile reads as its bucket's upper edge */
export const LATENCY_EDGES = [2, 5, 10, 20, 30, 60, 120, 300, 600, Infinity] as const;
export const latencyBucket = (ms: number) => LATENCY_EDGES.findIndex(edge => ms / 1000 <= edge);

export type UsageKind = "turn" | "run" | "frustration" | "session" | "digest" | "signal";
type Kind = UsageKind;
/** where the workspace ran and which app version, taken from the workspace as its notes arrived; only notes carry it */
export interface UsageRan { place: UsagePlace; os?: string; version?: string }
/** a note's `accountId` and `workspaceId` are empty: notes are kept apart from who sent them. `test`: a note from a test
 * account, a harness install or a dev build, kept out of the admin's views */
export interface UsageRecord { id: string; kind: Kind; at: number; accountId: string; workspaceId: string; ran?: UsageRan; test?: true; data: UsageTurn | UsageRun | UsageFrustration | UsageSession | UsageDigest | UsageSignal }
/** `appTurns`: turns that used a connected app, so the adoption view can count people who use one; `bots` and `chats`:
 * turns per salted bot and chat hash, for per-bot share and turns per chat */
/** `fails`: turns per failed tool and error class (`toolFailKey`), for the people column of tool failures */
export interface PersonDay { day: string; accountId: string; turns: number; failed: number; runs: number; frustrations: number; appTurns: number; bots?: Record<string, number>; chats?: Record<string, number>; fails?: Record<string, number> }
type PersonMaps = { bots?: Record<string, number>; chats?: Record<string, number>; fails?: Record<string, number> };
const PERSON_MAPS = ["bots", "chats", "fails"] as const;
const PERSON_MAP_KEY: Record<(typeof PERSON_MAPS)[number], RegExp> = { bots: /^[A-Za-z0-9_-]{10}$/, chats: /^[A-Za-z0-9_-]{10}$/, fails: /^[a-z]{2,12}(?::[a-z][a-z0-9_]{0,31})?\|[a-z_]{2,20}$/ };
/** a failed tool and its error class as one counter key; the tool's `.` becomes `:` since Mongo reads a dot as a path */
export const toolFailKey = (tool: string, error: string) => `${tool.replace(".", ":")}|${error}`;
type PersonCounts = Partial<Pick<PersonDay, "turns" | "failed" | "runs" | "frustrations" | "appTurns">>;
/** one routine by its salted hash: its first and last run, for "still running a week later" */
export interface RoutineSpan { workspaceId: string; accountId: string; routine: string; first: number; last: number; runs: number }
export interface SnapshotRow { workspaceId: string; accountId: string; at: number; snapshot: UsageSnapshot }

export interface UsageStore {
  /** the records not seen before; a record sent twice is kept once */
  insert(records: UsageRecord[]): Promise<UsageRecord[]>;
  bump(day: string, inc: Record<string, number>): Promise<void>;
  /** adds to a person's day; true when it is the person's first record that day */
  person(day: string, accountId: string, inc: PersonCounts, maps?: PersonMaps): Promise<boolean>;
  routine(span: Omit<RoutineSpan, "runs">): Promise<void>;
  routines(): Promise<RoutineSpan[]>;
  snapshot(row: SnapshotRow): Promise<void>;
  daily(fromDay: string, toDay: string): Promise<Array<{ day: string; c: Record<string, number> }>>;
  people(fromDay: string, toDay: string): Promise<PersonDay[]>;
  snapshots(): Promise<SnapshotRow[]>;
  records(kind: Kind, since: number, until: number, limit: number): Promise<UsageRecord[]>;
  /** true the first time a key is seen; kept forever */
  once(key: string): Promise<boolean>;
  forget(accountId: string): Promise<void>;
  forgetWorkspace(workspaceId: string): Promise<void>;
  /** deletes notes by their stored ids (`noteKey`) */
  forgetNotes(keys: string[]): Promise<void>;
}

export function memoryUsageStore(now: () => number = Date.now): UsageStore {
  const spans = new Map<string, RoutineSpan>();
  const records = new Map<string, UsageRecord>(), daily = new Map<string, Record<string, number>>(), people = new Map<string, PersonDay>(), snaps = new Map<string, SnapshotRow>(), marks = new Set<string>();
  const sweep = () => { const cutoff = now() - USAGE_RETENTION_DAYS * DAY_MS; for (const [id, record] of records) if (record.at < cutoff) records.delete(id); };
  return {
    async insert(list) {
      sweep();
      const fresh: UsageRecord[] = [];
      for (const record of list) { const key = `${record.workspaceId}:${record.id}`; if (!records.has(key)) { records.set(key, record); fresh.push(record); } }
      return fresh;
    },
    async bump(day, inc) { const row = daily.get(day) ?? {}; for (const [key, by] of Object.entries(inc)) row[key] = (row[key] ?? 0) + by; daily.set(day, row); },
    async person(day, accountId, inc, maps = {}) {
      const key = `${day}|${accountId}`, row = people.get(key), first = !row;
      const next: PersonDay = row ?? { day, accountId, turns: 0, failed: 0, runs: 0, frustrations: 0, appTurns: 0 };
      for (const [field, by] of Object.entries(inc)) (next as unknown as Record<string, number>)[field]! += by ?? 0;
      for (const kind of PERSON_MAPS) for (const [hash, by] of Object.entries(maps[kind] ?? {})) { const map = (next[kind] ??= {}); map[hash] = (map[hash] ?? 0) + by; }
      people.set(key, next);
      return first;
    },
    async routine(span) {
      const key = `${span.workspaceId}|${span.routine}`, row = spans.get(key);
      spans.set(key, row ? { ...row, first: Math.min(row.first, span.first), last: Math.max(row.last, span.last), runs: row.runs + 1 } : { ...span, runs: 1 });
    },
    async routines() { return [...spans.values()]; },
    async snapshot(row) { snaps.set(row.workspaceId, row); },
    async daily(fromDay, toDay) { return [...daily].filter(([day]) => day >= fromDay && day <= toDay).map(([day, c]) => ({ day, c: { ...c } })); },
    async people(fromDay, toDay) { return [...people.values()].filter(row => row.day >= fromDay && row.day <= toDay); },
    async snapshots() { return [...snaps.values()]; },
    async records(kind, since, until, limit) { return [...records.values()].filter(r => r.kind === kind && r.at >= since && r.at < until).sort((a, b) => b.at - a.at).slice(0, limit); },
    async once(key) { if (marks.has(key)) return false; marks.add(key); return true; },
    async forget(accountId) {
      for (const [key, record] of records) if (record.accountId === accountId) records.delete(key);
      for (const [key, row] of people) if (row.accountId === accountId) people.delete(key);
      for (const [key, row] of snaps) if (row.accountId === accountId) snaps.delete(key);
      for (const [key, row] of spans) if (row.accountId === accountId) spans.delete(key);
    },
    async forgetWorkspace(workspaceId) {
      for (const [key, record] of records) if (record.workspaceId === workspaceId) records.delete(key);
      snaps.delete(workspaceId);
    },
    async forgetNotes(keys) { for (const key of keys) records.delete(`:${key}`); },
  };
}

type RecordDoc = { _id: string; kind: Kind; at: Date; accountId?: string; workspaceId?: string; ran?: UsageRan; test?: true; data: UsageRecord["data"] };
const docId = (record: Pick<UsageRecord, "workspaceId" | "id">) => record.workspaceId ? `${record.workspaceId}:${record.id}` : record.id;
/** usage_events (TTL on `at`), usage_daily (kept), usage_people (TTL on `at`), usage_snapshots (one per workspace) */
export async function mongoUsageStore(db: Db, retention: SweepOptions = {}): Promise<UsageStore> {
  const events = db.collection<RecordDoc>("usage_events"), daily = db.collection<{ _id: string; day: string; c: Record<string, number> }>("usage_daily");
  const people = db.collection<{ _id: string; day: string; accountId: string; at: Date; turns: number; failed: number; runs: number; frustrations: number; appTurns: number }>("usage_people");
  const snaps = db.collection<{ _id: string; accountId: string; at: Date; snapshot: UsageSnapshot }>("usage_snapshots"), marks = db.collection<{ _id: string }>("usage_marks");
  const spans = db.collection<{ _id: string; workspaceId: string; accountId: string; routine: string; first: Date; last: Date; runs: number }>("usage_routines");
  // index steps never stop the service: one that is refused is a warning and the service runs on
  const seconds = USAGE_RETENTION_DAYS * 86_400, ttl = await ttlIndex(events, seconds);
  const indexed = (name: string, step: Promise<unknown>) => step.catch((error: Error & { code?: number }) => console.warn(`usage: the ${name} indexes were not made (${error.code ?? error.name}); the service runs without them`));
  await Promise.all([
    indexed("usage_events", events.createIndexes([...(ttl === "sweep" ? [] : [{ key: { at: 1 }, expireAfterSeconds: seconds }]), { key: { kind: 1, at: -1 } }, { key: { accountId: 1 } }, { key: { workspaceId: 1 } }])),
    indexed("usage_people", people.createIndexes([{ key: { at: 1 }, expireAfterSeconds: PEOPLE_RETENTION_DAYS * 86_400 }, { key: { day: 1 } }, { key: { accountId: 1 } }])),
    indexed("usage_snapshots", snaps.createIndexes([{ key: { accountId: 1 } }])),
    indexed("usage_routines", spans.createIndexes([{ key: { last: 1 }, expireAfterSeconds: PEOPLE_RETENTION_DAYS * 86_400 }, { key: { accountId: 1 } }])),
  ]);
  if (ttl === "sweep") startSweep(events, seconds, retention);
  // notes stored before they were kept apart get their account and workspace taken off, in the background
  void unlinkNotes(events).catch(error => console.warn(`usage: unlinking stored notes stopped (${(error as Error).message}); it resumes at the next start`));
  const toRecord = (doc: RecordDoc): UsageRecord => ({ id: doc.workspaceId ? doc._id.slice(doc.workspaceId.length + 1) : doc._id, kind: doc.kind, at: doc.at.getTime(), accountId: doc.accountId ?? "",
    workspaceId: doc.workspaceId ?? "", ...(doc.ran ? { ran: doc.ran } : {}), ...(doc.test ? { test: true as const } : {}), data: doc.data });
  return {
    async insert(list) {
      if (!list.length) return [];
      const docs = list.map(record => ({ _id: docId(record), kind: record.kind, at: new Date(record.at), ...(record.accountId ? { accountId: record.accountId } : {}),
        ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}), ...(record.ran ? { ran: record.ran } : {}), ...(record.test ? { test: true as const } : {}), data: record.data }));
      const failed = new Set<number>();
      try { await events.insertMany(docs, { ordered: false }); } catch (error) {
        const errors = (error as { writeErrors?: Array<{ index: number; code: number }> | { index: number; code: number } }).writeErrors;
        const list_ = Array.isArray(errors) ? errors : errors ? [errors] : null;
        if (!list_ || list_.some(item => item.code !== 11000)) throw error;
        for (const item of list_) failed.add(item.index);
      }
      return list.filter((_, index) => !failed.has(index));
    },
    async bump(day, inc) { await daily.updateOne({ _id: day }, { $setOnInsert: { day }, $inc: Object.fromEntries(Object.entries(inc).map(([key, by]) => [`c.${key}`, by])) }, { upsert: true }); },
    async person(day, accountId, inc, maps = {}) {
      const mapped = Object.fromEntries(PERSON_MAPS.flatMap(kind => Object.entries(maps[kind] ?? {}).filter(([key]) => PERSON_MAP_KEY[kind].test(key)).map(([key, by]) => [`${kind}.${key}`, by])));
      const result = await people.updateOne({ _id: `${day}|${accountId}` }, { $setOnInsert: { day, accountId, at: new Date(`${day}T12:00:00Z`) }, $inc: { turns: 0, failed: 0, runs: 0, frustrations: 0, appTurns: 0, ...inc, ...mapped } }, { upsert: true });
      return result.upsertedCount === 1;
    },
    async routine(span) {
      await spans.updateOne({ _id: `${span.workspaceId}|${span.routine}` }, { $setOnInsert: { workspaceId: span.workspaceId, accountId: span.accountId, routine: span.routine },
        $min: { first: new Date(span.first) }, $max: { last: new Date(span.last) }, $inc: { runs: 1 } }, { upsert: true });
    },
    async routines() { return (await spans.find({}).toArray()).map(doc => ({ workspaceId: doc.workspaceId, accountId: doc.accountId, routine: doc.routine, first: doc.first.getTime(), last: doc.last.getTime(), runs: doc.runs })); },
    async snapshot(row) { await snaps.replaceOne({ _id: row.workspaceId }, { accountId: row.accountId, at: new Date(row.at), snapshot: row.snapshot }, { upsert: true }); },
    async daily(fromDay, toDay) { return (await daily.find({ _id: { $gte: fromDay, $lte: toDay } }).toArray()).map(doc => ({ day: doc.day, c: doc.c ?? {} })); },
    async people(fromDay, toDay) {
      return (await people.find({ day: { $gte: fromDay, $lte: toDay } }, { projection: { _id: 0, at: 0 } }).toArray()) as unknown as PersonDay[];
    },
    async snapshots() { return (await snaps.find({}).toArray()).map(doc => ({ workspaceId: doc._id, accountId: doc.accountId, at: doc.at.getTime(), snapshot: doc.snapshot })); },
    async records(kind, since, until, limit) { return (await events.find({ kind, at: { $gte: new Date(since), $lt: new Date(until) } }).sort({ at: -1 }).limit(limit).toArray()).map(toRecord); },
    async once(key) { try { await marks.insertOne({ _id: key }); return true; } catch (error) { if ((error as { code?: number }).code === 11000) return false; throw error; } },
    async forget(accountId) { await Promise.all([events.deleteMany({ accountId }), people.deleteMany({ accountId }), snaps.deleteMany({ accountId }), spans.deleteMany({ accountId })]); },
    async forgetWorkspace(workspaceId) { await Promise.all([events.deleteMany({ workspaceId }), snaps.deleteOne({ _id: workspaceId })]); },
    async forgetNotes(keys) { if (keys.length) await events.deleteMany({ _id: { $in: keys }, kind: { $in: [...NOTE_KINDS] } }); },
  };
}

type Ttl = Pick<Collection<RecordDoc>, "indexes" | "dropIndex" | "createIndex">;
/** sets the TTL on `at` when an older start made it with another one (createIndexes refuses to change it). collMod needs
 * dbAdmin, which the service's user may not have; then the index is dropped and made again (readWrite allows that), and
 * when that is refused too, "sweep": the caller deletes expired records itself. never throws */
export async function ttlIndex(events: Ttl, seconds: number, run: (command: Record<string, unknown>) => Promise<unknown> = command => (events as Collection<RecordDoc>).db.command(command)): Promise<"ok" | "changed" | "rebuilt" | "sweep"> {
  const why = (error: unknown) => { const e = error as { code?: number; codeName?: string; name?: string }; return e.codeName ?? e.code ?? e.name ?? "error"; };
  let existing: Array<{ name?: string; key?: Record<string, unknown>; expireAfterSeconds?: number }>;
  try { existing = await events.indexes(); } catch (error) {
    if ((error as { codeName?: string }).codeName === "NamespaceNotFound") return "ok";
    console.warn(`usage: the usage_events indexes could not be read (${why(error)}); old records are deleted hourly instead`);
    return "sweep";
  }
  const ttl = existing.find(index => index.key && Object.keys(index.key).length === 1 && index.key.at === 1);
  if (!ttl || ttl.expireAfterSeconds === seconds) return "ok";
  const name = (events as Collection<RecordDoc>).collectionName;
  try { await run({ collMod: name, index: { keyPattern: { at: 1 }, expireAfterSeconds: seconds } }); return "changed"; } catch (refused) {
    try {
      await events.dropIndex(ttl.name ?? "at_1");
      await events.createIndex({ at: 1 }, { expireAfterSeconds: seconds });
      console.log(`usage: the usage_events TTL was made again with ${seconds}s (collMod refused: ${why(refused)})`);
      return "rebuilt";
    } catch (error) {
      console.warn(`usage: the usage_events TTL could not be changed (collMod ${why(refused)}, rebuild ${why(error)}); old records are deleted hourly instead`);
      return "sweep";
    }
  }
}

export interface SweepOptions { everyMs?: number; batch?: number; maxBatches?: number; now?: () => number }
/** deletes records older than `seconds`, a capped number of batches at a time; the work a TTL index would do */
export async function sweepExpired(events: Pick<Collection<RecordDoc>, "find" | "deleteMany">, seconds: number, { batch = 1_000, maxBatches = 20, now = Date.now }: SweepOptions = {}): Promise<number> {
  const before = new Date(now() - seconds * 1000);
  let removed = 0;
  for (let round = 0; round < maxBatches; round++) {
    const ids = (await events.find({ at: { $lt: before } }, { projection: { _id: 1 } }).limit(batch).toArray()).map(doc => doc._id);
    if (!ids.length) break;
    removed += (await events.deleteMany({ _id: { $in: ids }, at: { $lt: before } })).deletedCount ?? 0;
    if (ids.length < batch) break;
  }
  return removed;
}
function startSweep(events: Pick<Collection<RecordDoc>, "find" | "deleteMany">, seconds: number, options: SweepOptions) {
  const sweep = () => void sweepExpired(events, seconds, options).catch((error: Error & { code?: number }) => console.warn(`usage: deleting old records failed (${error.code ?? error.name}); it tries again in an hour`));
  setImmediate(sweep);
  setInterval(sweep, options.everyMs ?? 3_600_000).unref();
}

export const UNLINK_BATCH = 500;
/** moves notes stored with their account and workspace to `noteKey` with neither, in batches; a note already moved
 * stays put, so it can stop anywhere and run again */
export async function unlinkNotes(events: Pick<Collection<RecordDoc>, "find" | "insertMany" | "deleteMany">): Promise<number> {
  let moved = 0;
  for (;;) {
    const batch = await events.find({ kind: { $in: [...NOTE_KINDS] }, $or: [{ accountId: { $exists: true } }, { workspaceId: { $exists: true } }] }).limit(UNLINK_BATCH).toArray();
    if (!batch.length) return moved;
    const docs = batch.map(unlinkedDoc);
    try { await events.insertMany(docs, { ordered: false }); } catch (error) {
      const errors = (error as { writeErrors?: Array<{ code: number }> | { code: number } }).writeErrors;
      const list = Array.isArray(errors) ? errors : errors ? [errors] : null;
      if (!list || list.some(item => item.code !== 11000)) throw error;
    }
    await events.deleteMany({ _id: { $in: batch.map(doc => doc._id) } });
    moved += batch.length;
  }
}
export function unlinkedDoc(doc: RecordDoc): RecordDoc {
  const id = (doc.data as { id?: unknown }).id, raw = typeof id === "string" ? id : doc.workspaceId ? doc._id.slice(doc.workspaceId.length + 1) : doc._id;
  const key = raw.startsWith("note_") ? raw : noteKey(raw);
  return { _id: key, kind: doc.kind, at: doc.at, ...(doc.ran ? { ran: doc.ran } : {}), ...(doc.test ? { test: true as const } : {}), data: { ...doc.data, id: key } as RecordDoc["data"] };
}

/** a usage report with only its notes, for an account whose usage counts are not kept */
export const notesOnly = (report: UsageReport): UsageReport => ({ turns: [], runs: [], ...(report.frustrations ? { frustrations: report.frustrations } : {}),
  ...(report.sessions ? { sessions: report.sessions } : {}), ...(report.digests ? { digests: report.digests } : {}) });


/** a frustration's problem group: engine, category and the first app or tool it touched */
export const problemKey = (f: Pick<UsageFrustration, "engine" | "category" | "apps" | "tools">) => `${f.engine}|${f.category}|${f.apps[0] ?? f.tools.find(tool => tool !== "memory" && tool !== "other") ?? "none"}`;

/** the day's counters a set of fresh records adds, keyed flat so they sum across days */
export function rollup(records: UsageRecord[]): Map<string, Record<string, number>> {
  const days = new Map<string, Record<string, number>>();
  const add = (day: string, key: string, by = 1) => { const row = days.get(day) ?? {}; row[key] = (row[key] ?? 0) + by; days.set(day, row); };
  for (const record of records) {
    const day = dayOf(record.at);
    if (record.kind === "turn") {
      const t = record.data as UsageTurn, failed = t.outcome === "failed", bucket = latencyBucket(t.ms);
      add(day, "turns"); add(day, t.outcome); add(day, `lat:${bucket}`); add(day, `ms`, t.ms);
      if (t.firstMs !== undefined) { const first = latencyBucket(t.firstMs); add(day, `first:${first}`); add(day, `first_engine:${t.engine}:${first}`); if (t.model) add(day, `first_model:${t.model}:${first}`); }
      if (t.model) { add(day, `model:${t.model}`); add(day, `lat_model:${t.model}:${bucket}`); if (failed) add(day, `model_fail:${t.model}`); }
      for (const tool of t.failedTools ?? []) add(day, `tool_err:${tool}`);
      for (const app of t.failedApps ?? []) add(day, `app_err:${app}`);
      for (const f of t.toolFailures ?? []) { const key = toolFailKey(f.tool, f.error); add(day, `tfail:${key}`); add(day, `tfail_calls:${key}`, f.count); }
      for (const action of t.actions ?? []) add(day, `action:${action}`);
      add(day, `engine:${t.engine}`); add(day, `lat_engine:${t.engine}:${bucket}`); add(day, `category:${t.category}`); add(day, `from:${t.from}`); add(day, `place:${t.place}`);
      if (t.room) add(day, "room");
      for (const tool of t.tools) add(day, `tool:${tool}`);
      for (const app of t.apps) add(day, `app:${app}`);
      if (failed) {
        const reason = t.reason ?? "unknown";
        add(day, `engine_fail:${t.engine}`); add(day, `category_fail:${t.category}`); add(day, `reason:${reason}`); add(day, `reason_engine:${t.engine}:${reason}`);
        for (const tool of t.tools) { add(day, `tool_fail:${tool}`); add(day, `reason_tool:${tool}:${reason}`); }
        for (const app of t.apps) { add(day, `app_fail:${app}`); add(day, `reason_app:${app}:${reason}`); }
      }
      if (t.outcome === "cancelled") add(day, `engine_cancel:${t.engine}`);
    } else if (record.kind === "run") {
      const r = record.data as UsageRun;
      add(day, "runs"); add(day, `run:${r.trigger}`);
      if (r.every) { add(day, `every:${r.every}`); if (r.outcome === "failed") add(day, `every_fail:${r.every}`); }
      if (r.ms !== undefined) add(day, `run_ms:${latencyBucket(r.ms)}`);
      if (r.outcome === "failed") { add(day, "run_failed"); add(day, `run_fail:${r.trigger}`); add(day, `run_reason:${r.reason ?? "unknown"}`); }
    } else if (record.kind === "frustration") {
      const f = record.data as UsageFrustration;
      add(day, "frustrations"); add(day, `fr_group:${problemKey(f)}`);
      for (const signal of f.signals) add(day, `fr_signal:${signal}`);
    } else if (record.kind === "session") {
      add(day, "sessions");
    } else if (record.kind === "signal") {
      const g = record.data as UsageSignal;
      add(day, `sig:${g.name}`);
      for (const [key, value] of Object.entries(g.props)) if (typeof value === "string" || typeof value === "number") add(day, `sig:${g.name}:${key}:${value}`);
    } else add(day, "digests");
  }
  return days;
}

/** the place the report's turns ran most, else what the workspace's kind says; the version as the workspace reported it */
export function ranOf(report: UsageReport, from?: { kind?: string; version?: string }): UsageRan | undefined {
  const count = new Map<UsagePlace, number>();
  for (const turn of report.turns) count.set(turn.place, (count.get(turn.place) ?? 0) + 1);
  const seen = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  const place = seen ?? (from?.kind ? from.kind === "vps" ? "server" : "desktop" : undefined);
  if (!place) return undefined;
  const version = from?.version && /^[\w.+-]{1,20}$/.test(from.version) ? from.version : undefined;
  const os = from?.kind && /^[a-z]{2,10}$/.test(from.kind) ? from.kind : undefined;
  return { place, ...(os ? { os } : {}), ...(version ? { version } : {}) };
}

export function createUsage(options: {
  store: UsageStore; now?: () => number;
  /** the account turned "help improve dusk bot" off */
  optedOut(accountId: string): boolean;
  /** the account's session notes are on; without it notes are kept whenever usage is */
  notesOn?(accountId: string): boolean;
  /** a note from a test account, a harness install or a dev build */
  isTest?(accountId: string, workspaceId: string, ran?: UsageRan): boolean;
  /** a frustration group seen for the first time ever */
  newProblem?(group: { key: string; example: string | null; count: number }): void;
}) {
  const { store } = options, now = options.now ?? Date.now;
  const stats = { written: 0, failed: 0, dropped: 0 };
  /** an account's notes as records kept apart from it: no account, no workspace, the id hashed; none without a yes */
  function noteRecords(accountId: string | null, workspaceId: string, notes: Pick<UsageReport, "frustrations" | "sessions" | "digests">, ran?: UsageRan): UsageRecord[] {
    if (!accountId || options.optedOut(accountId) || options.notesOn?.(accountId) === false) return [];
    const extra = { ...(ran ? { ran } : {}), ...(options.isTest?.(accountId, workspaceId, ran) ? { test: true as const } : {}) };
    const own = <T extends { id: string; at: number }>(kind: NoteKind, data: T): UsageRecord => {
      const key = noteKey(data.id);
      return { id: key, kind, at: data.at, accountId: "", workspaceId: "", ...extra, data: { ...data, id: key } as unknown as UsageRecord["data"] };
    };
    return [...(notes.frustrations ?? []).map(data => own("frustration", data)), ...(notes.sessions ?? []).map(data => own("session", data)), ...(notes.digests ?? []).map(data => own("digest", data))];
  }
  async function problems(fresh: UsageRecord[]) {
    for (const record of fresh) if (record.kind === "frustration" && options.newProblem) {
      const f = record.data as UsageFrustration, key = problemKey(f);
      if (await store.once(`problem|${key}`)) options.newProblem({ key, example: f.summary ?? null, count: 1 });
    }
  }
  /** the notes alone (a bad chat, a big session, the weekly one), from an account's app sending them itself; an app
   * no account signed in to sends none that are kept */
  async function ingestNotes(accountId: string | null, workspaceId: string, notes: Pick<UsageReport, "frustrations" | "sessions" | "digests">, ran?: UsageRan) {
    const records = noteRecords(accountId, workspaceId, notes, ran);
    if (!records.length) { if (notes.frustrations?.length || notes.sessions?.length || notes.digests?.length) stats.dropped++; return 0; }
    const fresh = await store.insert(records);
    await Promise.all([...rollup(fresh)].map(([day, inc]) => store.bump(day, inc)));
    await problems(fresh);
    stats.written += fresh.length;
    return fresh.length;
  }
  async function ingest(accountId: string | null, workspaceId: string, report: UsageReport, from?: { kind?: string; version?: string }) {
    if (!accountId) { stats.dropped++; return; }
    if (options.optedOut(accountId)) { stats.dropped++; return; }
    try {
      const ran = ranOf(report, from);
      const records: UsageRecord[] = [
        ...report.turns.map(data => ({ id: data.id, kind: "turn" as const, at: data.at, accountId, workspaceId, data })),
        ...report.runs.map(data => ({ id: data.id, kind: "run" as const, at: data.at, accountId, workspaceId, data })),
        ...noteRecords(accountId, workspaceId, report, ran),
        ...(report.signals ?? []).map(data => ({ id: data.id, kind: "signal" as const, at: data.at, accountId, workspaceId, data })),
      ];
      const fresh = await store.insert(records);
      const writes: Array<Promise<unknown>> = [];
      for (const [day, inc] of rollup(fresh)) writes.push(store.bump(day, inc));
      const perDay = new Map<string, { turns: number; failed: number; runs: number; frustrations: number; appTurns: number; bots: Record<string, number>; chats: Record<string, number>; fails: Record<string, number> }>();
      for (const record of fresh) {
        const day = dayOf(record.at), row = perDay.get(day) ?? { turns: 0, failed: 0, runs: 0, frustrations: 0, appTurns: 0, bots: {}, chats: {}, fails: {} };
        if (record.kind === "turn") {
          const t = record.data as UsageTurn;
          row.turns++; if (t.outcome === "failed") row.failed++; if (t.apps.length) row.appTurns++;
          if (t.bot) row.bots[t.bot] = (row.bots[t.bot] ?? 0) + 1;
          if (t.chat) row.chats[t.chat] = (row.chats[t.chat] ?? 0) + 1;
          for (const f of t.toolFailures ?? []) { const key = toolFailKey(f.tool, f.error); row.fails[key] = (row.fails[key] ?? 0) + 1; }
        }
        if (record.kind === "run") {
          row.runs++;
          const r = record.data as UsageRun;
          if (r.routine) writes.push(store.routine({ workspaceId, accountId, routine: r.routine, first: r.at, last: r.at }));
        }
        // a note's count stays with the account's day; the note itself does not
        if (record.kind === "frustration") row.frustrations++;
        perDay.set(day, row);
      }
      for (const [day, { bots, chats, fails, ...inc }] of perDay) writes.push(store.person(day, accountId, inc, { bots, chats, fails }).then(first => first ? store.bump(day, { people: 1 }) : undefined));
      if (report.snapshot) writes.push(store.snapshot({ workspaceId, accountId, at: now(), snapshot: report.snapshot }));
      await Promise.all(writes);
      await problems(fresh);
      stats.written += fresh.length;
    } catch { stats.failed++; }
  }
  /** what a workspace (or an app, with `workspaceId` null) asked to have deleted: its notes by id, its records */
  async function forgetShared(workspaceId: string | null, forget: UsageForget) {
    try {
      await Promise.all([store.forgetNotes(forget.notes.map(noteKey)), ...(forget.records && workspaceId ? [store.forgetWorkspace(workspaceId)] : [])]);
    } catch { stats.failed++; }
  }
  return { store, stats, ingest, ingestNotes, forgetShared, forget: (accountId: string) => store.forget(accountId).catch(() => { stats.failed++; }),
    forgetWorkspace: (workspaceId: string) => store.forgetWorkspace(workspaceId).catch(() => { stats.failed++; }) };
}
export type Usage = ReturnType<typeof createUsage>;

export const REASON_WORDS: Record<(typeof USAGE_REASONS)[number], string> = {
  rate_limit: "hit rate limits", quota: "ran out of plan usage", auth: "sign-in expired or was refused", timeout: "timed out", network: "network trouble",
  context: "the chat got too long", refused: "the ai refused", crashed: "the engine crashed", tool: "a tool broke", model_not_found: "the model was not found",
  bad_request: "the provider refused the request", provider_down: "the provider had an outage", cli_missing: "the engine is not installed",
  cli_exit_early: "the engine quit before replying", no_reply: "the ai sent no reply", missed: "the computer was off or asleep", held: "held by a limit or cap",
  not_ready: "the ai could not start", script: "its script failed", restarted: "dusk bot restarted mid-run", unanswered: "nobody answered its question", unknown: "no clear reason",
};
