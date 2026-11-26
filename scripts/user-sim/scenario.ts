// The scenario format (scenarios/*.json, one scenario per file, id = file name) and its validation.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APPS, getContentDir, loadWorld, worldIds } from "./world.ts";

/** One conversation: the person opens with `opener` (or writes one toward `goal`) and talks until done or `maxTurns`. */
export interface ChatStep {
  chat: {
    goal: string;
    opener?: string;
    /** facts the person gives when asked */
    knows?: string;
    maxTurns?: number;
    /** "new" (default) starts a conversation; "main" is the bot's main chat; any other word names a conversation to come
     * back to later ("same" is the previous one) */
    thread?: string;
    /** another bot by name; default the main bot */
    bot?: string;
    /** the opener replies to the newest bot message matching this pattern (as replying to a message in the app) */
    replyTo?: string;
    label?: string;
  };
}
/** Moves the clock: "+3h", "+45m", "+1d" or "+1d 08:05" (that local time n days on). */
export interface AdvanceStep { advance: string; label?: string }
/** New items land in the connected apps (mail, events, slack messages…), times relative to the moment it happens. */
export interface InjectStep { inject: Record<string, unknown>; label?: string }
/** The next `times` calls of a tool fail with `error`. */
export interface FaultStep { fault: Record<string, { times: number; error: string }>; label?: string }
/** Wait for routine runs, memory upkeep and anything the bot scheduled to finish: at least `seconds`. */
export interface SettleStep { settle: { seconds?: number }; label?: string }
export type Step = ChatStep | AdvanceStep | InjectStep | FaultStep | SettleStep;

/** A field → regex map; a field may be a dotted path. Regexes are case-insensitive. */
export type Where = Record<string, string>;

export type Check = { label: string; recall?: boolean } & (
  /** rows in the connectors' state at `path` ("sent", "events", "slack.channels.ops.messages", "github.repos.0.issues") */
  | { app: string; where?: Where; min?: number; max?: number }
  /** the bot's routines (name, prompt, schedule, probe…) and, with ran, a finished run */
  | { routine: { where?: Where; ran?: boolean }; min?: number; max?: number }
  /** what the bot said in one chat step (by label, or "last"), or anywhere when step is left out */
  | { said: { step?: string; bot?: string; match?: string; not?: string } }
  /** a bot message that came on its own, with no person's message before it in that step */
  | { proactive: { after?: string; bot?: string; match?: string }; min?: number; max?: number }
  /** the bot's memory files and About me */
  | { memory: { match?: string; not?: string; bot?: string } }
  /** a file in the person's home folder */
  | { file: { path: string; match?: string } }
  /** the bot's tool calls in one chat step (by label), or anywhere: `match` against the tool's name and input */
  | { tool: { step?: string; match: string }; min?: number; max?: number }
  /** a file or folder in the person's home folder that must be gone */
  | { gone: { path: string } }
);

export interface Scenario {
  id: string;
  title: string;
  world: string;
  tags: string[];
  /** more bots besides the main one, by name, with optional standing instructions, role title and description */
  bots?: Array<{ name: string; soul?: string; title?: string; description?: string }>;
  /** merged into the world: arrays append, objects merge */
  seed?: Record<string, unknown>;
  /** overrides the world's start, e.g. "tue 08:40" */
  start?: string;
  /** the connected apps for this scenario, replacing the world's list */
  apps?: string[];
  /** command line tools the person has signed in on their computer, served from the same app state ("gh") */
  cli?: Array<"gh">;
  /** the bot works on the computer it runs on (shell, files) and has its own browser, as a new bot does in the app;
   * left out, the bot has neither */
  computer?: boolean;
  /** the bot's AI is at its usage limit from the start until `until` (relative, "@+1d 02:00"), refusing with `message` */
  limit?: { until: string; message: string };
  steps: Step[];
  checks: Check[];
  /** what a great outcome looks like, for the judge */
  judge: string;
}

export function loadScenarios(dir = join(getContentDir(), "scenarios")): Scenario[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ ...JSON.parse(readFileSync(join(dir, f), "utf8")), id: f.slice(0, -5) }) as Scenario);
}

const NOT_KINDS = new Set(["label", "recall", "min", "max", "where"]);
const kinds = (o: object) => Object.keys(o).filter((k) => !NOT_KINDS.has(k));

export function validate(s: Scenario): string[] {
  const out: string[] = [];
  const bad = (msg: string) => out.push(`${s.id}: ${msg}`);
  if (!s.title) bad("no title");
  if (!worldIds().includes(s.world)) { bad(`unknown world ${s.world}`); return out; }
  const world = loadWorld(s.world);
  for (const app of s.apps ?? []) if (!(APPS as readonly string[]).includes(app)) bad(`unknown app ${app}`);
  for (const tool of s.cli ?? []) if (tool !== "gh") bad(`unknown cli ${tool}`);
  for (const app of world.apps) if (!(APPS as readonly string[]).includes(app)) bad(`world ${s.world} has unknown app ${app}`);
  if (!Array.isArray(s.tags) || !s.tags.length) bad("no tags");
  if (!s.judge) bad("no judge text");
  const botNames = new Set([world.botName, ...(s.bots ?? []).map((b) => b.name)]);
  const labels = new Set<string>();
  if (!s.steps?.length || !s.steps.some((st) => "chat" in st)) bad("needs at least one chat step");
  for (const [i, st] of (s.steps ?? []).entries()) {
    const k = kinds(st);
    if (k.length !== 1 || !["chat", "advance", "inject", "fault", "settle"].includes(k[0]!)) { bad(`step ${i} must have exactly one of chat/advance/inject/fault/settle`); continue; }
    const label = "chat" in st ? st.chat.label : (st as { label?: string }).label;
    if (label) { if (labels.has(label)) bad(`duplicate label ${label}`); labels.add(label); }
    if ("chat" in st) {
      if (!st.chat.goal) bad(`step ${i} chat has no goal`);
      if (st.chat.bot && !botNames.has(st.chat.bot)) bad(`step ${i} names unknown bot ${st.chat.bot}`);
      try { if (st.chat.replyTo) new RegExp(st.chat.replyTo, "i"); } catch { bad(`step ${i} replyTo is not a regex`); }
    }
    if ("advance" in st && !/^\+\d+[dhm](\s+\d{1,2}:\d{2})?$/.test(st.advance)) bad(`step ${i} advance "${st.advance}" must look like +1d 08:05, +3h or +45m`);
    if ("inject" in st) for (const key of Object.keys(st.inject)) if (!["mail", "events", "slack", "github", "notes", "shop", "crm", "files"].includes(key)) bad(`step ${i} injects unknown ${key}`);
  }
  for (const c of s.checks ?? []) {
    if (!c.label) bad("a check has no label");
    const k = kinds(c);
    if (k.length !== 1 || !["app", "routine", "said", "proactive", "memory", "file", "tool", "gone"].includes(k[0]!)) { bad(`check "${c.label}" must have exactly one kind`); continue; }
    const regexes: Array<string | undefined> = [];
    if ("app" in c) regexes.push(...Object.values(c.where ?? {}));
    if ("routine" in c) regexes.push(...Object.values(c.routine.where ?? {}));
    if ("said" in c) { regexes.push(c.said.match, c.said.not); if (c.said.step && c.said.step !== "last" && !labels.has(c.said.step)) bad(`check "${c.label}" names unknown step ${c.said.step}`); }
    if ("proactive" in c) { regexes.push(c.proactive.match); if (c.proactive.after && !labels.has(c.proactive.after)) bad(`check "${c.label}" names unknown step ${c.proactive.after}`); }
    if ("memory" in c) regexes.push(c.memory.match, c.memory.not);
    if ("file" in c) regexes.push(c.file.match);
    if ("tool" in c) { regexes.push(c.tool.match); if (c.tool.step && !labels.has(c.tool.step)) bad(`check "${c.label}" names unknown step ${c.tool.step}`); }
    for (const r of regexes) if (r) try { new RegExp(r, "i"); } catch { bad(`check "${c.label}" has a bad regex ${r}`); }
  }
  if (!s.checks?.length) bad("no checks");
  const text = JSON.stringify({ steps: s.steps, seed: s.seed, bots: s.bots });
  if (/\b(test(ing|s|ed)?|eval(uation|s)?|simulat\w*|benchmark|fixture|dummy|fake)\b/i.test(text)) bad("the bot would see a word that gives the setup away (test, eval, simulated, fake…)");
  return out;
}

/** Same rule for worlds: nothing the bot sees may say it is staged. */
export function validateWorld(id: string): string[] {
  const w = loadWorld(id);
  const visible = JSON.stringify({ ...w, persona: { name: w.persona.name, aboutMe: w.persona.aboutMe } });
  const out: string[] = [];
  if (/\b(test(ing|s|ed)?|eval(uation|s)?|simulat\w*|benchmark|fixture|dummy|fake|lorem)\b/i.test(visible)) out.push(`world ${id}: a word gives the setup away (test, eval, fake…)`);
  if (/@(example\.(com|org)|test\.)/i.test(visible)) out.push(`world ${id}: example.com or test. addresses look staged`);
  return out;
}
