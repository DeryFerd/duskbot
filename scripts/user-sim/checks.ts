// Ground-truth checks over what really exists after a scenario: the connectors' state, the bots' routines and runs, every
// message, memory and the person's home folder.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, Where } from "./scenario.ts";

export interface Msg { id: string; at: number; role: string; kind?: string; text?: string; threadId: string; botName: string }
export interface ToolCall { at: number; threadId: string; name: string; input: string }
export interface ChatRecord { label?: string; botName: string; threadId: string; start: number; end: number }
export interface Evidence {
  state: any;
  routines: any[];
  runs: any[];
  chats: ChatRecord[];
  /** every text message in every conversation of the scenario's bots, in fake-clock time */
  messages: Msg[];
  /** step label → fake-clock time the step began */
  stepAt: Record<string, number>;
  memory: Record<string, string>;
  aboutMe: string;
  home: string;
  mainBot: string;
  /** every tool call the bots made, from their activity lines */
  tools?: ToolCall[];
}
export interface CheckResult { label: string; ok: boolean; recall: boolean; detail: string }

const get = (value: any, path: string): any => path.split(".").reduce((v, key) => (v == null ? undefined : v[key]), value);
const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
const re = (pattern: string) => new RegExp(pattern, "i");
const matches = (row: any, where: Where = {}) => Object.entries(where).every(([path, pattern]) => re(pattern).test(text(get(row, path))));
/** With only `max` given, the floor is 0: "max": 0 means it must not happen. */
const bounds = (min?: number, max?: number) => ({ min: min ?? (max === undefined ? 1 : 0), max: max ?? Infinity });
const count = (n: number, min?: number, max?: number) => { const b = bounds(min, max); return n >= b.min && n <= b.max; };
const range = (minIn?: number, maxIn?: number) => { const { min, max } = bounds(minIn, maxIn); return max === Infinity ? `>=${min}` : min === max ? `${min}` : `${min}-${max}`; };

/** Bot text in a chat step: replies between the step's start and end in its conversation. */
function saidIn(ev: Evidence, label: string | undefined, bot?: string): string {
  const chats = label === "last" ? ev.chats.slice(-1) : label ? ev.chats.filter((c) => c.label === label) : [];
  const pool = label ? chats.flatMap((c) => ev.messages.filter((m) => m.threadId === c.threadId && m.at >= c.start && m.at <= c.end + 1_000))
    : ev.messages.filter((m) => !bot || m.botName === bot);
  return pool.filter((m) => m.role === "bot" && (!bot || m.botName === bot)).map((m) => m.text ?? "").join("\n");
}

/** When the bots exist and have said their hello; nothing before it counts as reaching out. */
export const SETUP_DONE = "(setup done)";

/** Bot messages that came on their own: outside every chat step's window, after `after`. */
export function proactiveMessages(ev: Evidence, after?: string, bot?: string): Msg[] {
  const from = after ? ev.stepAt[after] ?? Infinity : ev.stepAt[SETUP_DONE] ?? 0;
  const inChat = (m: Msg) => ev.chats.some((c) => c.threadId === m.threadId && m.at >= c.start && m.at <= c.end + 1_000);
  return ev.messages.filter((m) => m.role === "bot" && m.at >= from && !inChat(m) && (!bot || m.botName === bot));
}

export function runCheck(c: Check, ev: Evidence): CheckResult {
  const base = { label: c.label, recall: c.recall === true };
  try {
    if ("app" in c) {
      const rows = get(ev.state, c.app);
      const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? Object.values(rows) : [];
      const hits = list.filter((row: any) => matches(row, c.where));
      return { ...base, ok: count(hits.length, c.min, c.max), detail: `${hits.length} of ${list.length} in ${c.app} match (want ${range(c.min, c.max)})` };
    }
    if ("routine" in c) {
      const hits = ev.routines.filter((r) => matches(r, c.routine.where) && (!c.routine.ran || ev.runs.some((run) => run.routineId === r.id && run.status === "completed" && run.dryRun !== true)));
      return { ...base, ok: count(hits.length, c.min, c.max), detail: `${hits.length} routines match${c.routine.ran ? " with a completed run" : ""} (want ${range(c.min, c.max)}); exist: ${ev.routines.map((r) => r.name).join(", ") || "none"}` };
    }
    if ("said" in c) {
      const said = saidIn(ev, c.said.step, c.said.bot);
      const okMatch = !c.said.match || re(c.said.match).test(said);
      const okNot = !c.said.not || !re(c.said.not).test(said);
      return { ...base, ok: okMatch && okNot, detail: `${!okMatch ? `never said /${c.said.match}/` : ""}${!okNot ? ` said /${c.said.not}/` : ""}`.trim() || "ok" };
    }
    if ("proactive" in c) {
      const hits = proactiveMessages(ev, c.proactive.after, c.proactive.bot).filter((m) => !c.proactive.match || re(c.proactive.match).test(m.text ?? ""));
      return { ...base, ok: count(hits.length, c.min, c.max), detail: `${hits.length} proactive messages match (want ${range(c.min, c.max)})` };
    }
    if ("memory" in c) {
      const mem = `${c.memory.bot ? ev.memory[c.memory.bot] ?? "" : Object.values(ev.memory).join("\n")}\n${ev.aboutMe}`;
      // a struck-through line is a superseded fact, not a remembered one
      const live = mem.replace(/~~[^~]*~~/g, "");
      const okMatch = !c.memory.match || re(c.memory.match).test(live);
      const okNot = !c.memory.not || !re(c.memory.not).test(live);
      return { ...base, ok: okMatch && okNot, detail: `${!okMatch ? `memory lacks /${c.memory.match}/` : ""}${!okNot ? ` memory still has /${c.memory.not}/` : ""}`.trim() || "ok" };
    }
    if ("file" in c) {
      const path = join(ev.home, c.file.path);
      if (!existsSync(path)) return { ...base, ok: false, detail: `${c.file.path} missing` };
      const ok = !c.file.match || re(c.file.match).test(readFileSync(path, "utf8"));
      return { ...base, ok, detail: ok ? "ok" : `${c.file.path} lacks /${c.file.match}/` };
    }
    if ("tool" in c) {
      const chats = c.tool.step ? ev.chats.filter((one) => one.label === c.tool.step) : null;
      const pool = (ev.tools ?? []).filter((t) => !chats || chats.some((one) => one.threadId === t.threadId && t.at >= one.start && t.at <= one.end + 1_000));
      const hits = pool.filter((t) => re(c.tool.match).test(`${t.name} ${t.input}`));
      return { ...base, ok: count(hits.length, c.min, c.max), detail: `${hits.length} of ${pool.length} tool calls match (want ${range(c.min, c.max)}); used: ${[...new Set(pool.map((t) => t.name))].join(", ") || "none"}` };
    }
    if ("gone" in c) {
      const ok = !existsSync(join(ev.home, c.gone.path));
      return { ...base, ok, detail: ok ? "gone" : `${c.gone.path} still there` };
    }
    return { ...base, ok: false, detail: "unknown check kind" };
  } catch (error) {
    return { ...base, ok: false, detail: `check error: ${(error as Error).message}` };
  }
}
