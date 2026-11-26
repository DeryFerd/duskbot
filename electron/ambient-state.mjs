// What the island and the dock are allowed to know, checked in main: the app's page publishes a small summary of its
// bots, and the person's choices for the two surfaces live in ambient-prefs.json. Everything past these shapes is
// dropped, so a page can never put more than a short line per bot on screen.
import { DISPLAY_CHOICES, ISLAND_SIZE_IDS } from "./ambient-geometry.mjs";

export const AMBIENT_STATUSES = Object.freeze(["idle", "thinking", "working", "talking", "needs-you", "done", "error"]);
const COLORS = new Set(["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral", "brown", "silver", "chrome"]);
const ID = /^[\w.:-]{1,128}$/;
const BODY = /^[a-z0-9-]{1,40}$/;
const MAX_BOTS = 40;
const MAX_CHOICES = 4;
/** A bot's chat: the newest few messages of each, a long stretch of the one a surface shows, each cut short, and never
 * more than MAX_CHAT_TOTAL messages in one summary. */
const MAX_CHAT = 120;
const MAX_CHAT_TEXT = 2000;
const MAX_CHAT_TOTAL = 400;
const MAX_STREAMING = 4000;
/** Spaces collapse; a chat line keeps its line breaks. */
const lines = (value, max) => (typeof value === "string" ? value.replace(/\r/g, "").replace(/[^\S\n]+/g, " ").replace(/ *\n[\n ]*/g, "\n").trim().slice(0, max) : "");
const WAITS = ["question", "approval", "sign-in", "password", "connect", "review", "other"];
const STEPS = ["thinking", "reply", "read", "fetch", "web", "search", "command", "write", "edit", "tool"];
/** A typed answer to a question that takes one. */
const MAX_ANSWER = 2000;
const MAX_LABELS = 48;
const LABEL = /^[a-z][\w.-]{0,40}$/i;

const text = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const id = value => (typeof value === "string" && ID.test(value) ? value : null);
const count = value => (Number.isFinite(value) ? Math.max(0, Math.min(99, Math.floor(value))) : 0);
// only this app's own pictures, from the page's own origin
const avatar = value => (typeof value === "string" && /^\/[^/\\]/.test(value) && value.length <= 512 ? value : null);

function chatLine(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const said = lines(raw.text, MAX_CHAT_TEXT);
  if (!said) return null;
  return { id: id(raw.id) ?? `m${index}`, from: raw.from === "you" ? "you" : "bot", text: said, at: Number.isFinite(raw.at) && raw.at > 0 ? Math.floor(raw.at) : 0 };
}

function bot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const botId = id(raw.id), threadId = id(raw.threadId);
  if (!botId || !threadId) return null;
  const approval = raw.approval && typeof raw.approval === "object" && id(raw.approval.requestId) && id(raw.approval.threadId)
    ? { requestId: raw.approval.requestId, threadId: raw.approval.threadId, title: text(raw.approval.title, 160) }
    : null;
  const asked = raw.question && typeof raw.question === "object" ? raw.question : null;
  const choices = Array.isArray(asked?.choices) ? asked.choices.slice(0, MAX_CHOICES).map(entry => text(entry, 60)).filter(Boolean) : [];
  const custom = asked?.custom === true;
  const question = asked && id(asked.requestId) && id(asked.threadId) && (choices.length || custom)
    ? { requestId: asked.requestId, threadId: asked.threadId, title: text(asked.title, 240), choices, custom }
    : null;
  return {
    id: botId,
    threadId,
    name: text(raw.name, 60) || "Bot",
    color: COLORS.has(raw.color) ? raw.color : "green",
    body: typeof raw.body === "string" && BODY.test(raw.body) ? raw.body : null,
    face: raw.face === "white" || raw.face === "black" ? raw.face : null,
    avatar: avatar(raw.avatar),
    status: AMBIENT_STATUSES.includes(raw.status) ? raw.status : "idle",
    detail: text(raw.detail, 120),
    line: text(raw.line, 240),
    at: Number.isFinite(raw.at) && raw.at > 0 ? Math.floor(raw.at) : 0,
    unread: raw.unread === true,
    asks: count(raw.asks),
    approval,
    waits: WAITS.includes(raw.waits) ? raw.waits : null,
    question,
    step: STEPS.includes(raw.step) ? raw.step : null,
    quiet: raw.quiet === true,
    ...(Number.isFinite(raw.since) && raw.since > 0 ? { since: Math.floor(raw.since) } : {}),
    ...(raw.scheduled === true ? { scheduled: true } : {}),
    chat: Array.isArray(raw.chat) ? raw.chat.slice(-MAX_CHAT).map(chatLine).filter(Boolean) : [],
    ...(typeof raw.streaming === "string" && raw.streaming.trim() ? { streaming: lines(raw.streaming, MAX_STREAMING) } : {}),
    ...(raw.hasMore === true ? { hasMore: true } : {}),
  };
}

/** The page's summary as the surfaces get it, or null for anything that is not one. */
export function parseSnapshot(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.bots)) return null;
  const seen = new Set();
  const bots = [];
  let budget = MAX_CHAT_TOTAL;
  for (const entry of raw.bots.slice(0, MAX_BOTS)) {
    const parsed = bot(entry);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    parsed.chat = budget > 0 ? parsed.chat.slice(-budget) : [];
    budget -= parsed.chat.length;
    bots.push(parsed);
  }
  // the page's own words for the surfaces, already in the person's language, so their pages carry no language packs
  const labels = {};
  if (raw.labels && typeof raw.labels === "object" && !Array.isArray(raw.labels)) {
    for (const [key, value] of Object.entries(raw.labels).slice(0, MAX_LABELS)) if (LABEL.test(key) && typeof value === "string") labels[key] = text(value, 160);
  }
  const lang = typeof raw.lang === "string" && /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(raw.lang) ? raw.lang : "";
  return raw.away === true ? { bots: [], labels, lang, away: true } : { bots, labels, lang };
}

/** The actions an island or dock may ask the app's page to take; anything else is dropped. */
export function parseAct(raw) {
  if (!raw || typeof raw !== "object") return null;
  const botId = id(raw.botId), threadId = id(raw.threadId);
  if (raw.kind === "new-bot") return { kind: "new-bot" };
  if (!botId || !threadId) return null;
  if (raw.kind === "reply") {
    const message = typeof raw.text === "string" ? raw.text.trim().slice(0, 4000) : "";
    return message ? { kind: "reply", botId, threadId, text: message } : null;
  }
  if (raw.kind === "allow" || raw.kind === "deny") {
    const requestId = id(raw.requestId);
    return requestId ? { kind: raw.kind, botId, threadId, requestId } : null;
  }
  if (raw.kind === "answer") {
    // a choice or, where the question takes one, a typed answer: the app's page checks which
    const requestId = id(raw.requestId), choice = text(raw.text, MAX_ANSWER);
    return requestId && choice ? { kind: "answer", botId, threadId, requestId, text: choice } : null;
  }
  if (raw.kind === "stop") return { kind: "stop", botId, threadId };
  return null;
}

export const AMBIENT_DEFAULTS = Object.freeze({ island: true, dock: true, size: "medium", display: "active", order: [], seen: [] });
/** Finished replies and failures the person has seen (src/ambient/seen.ts keys): the newest this many are kept. */
export const MAX_SEEN = 300;
const SEEN_KEY = /^[\w.:-]{1,160}$/;

/** Seen keys, newest last, without repeats or anything that is not one. */
export function seenKeys(value) {
  if (!Array.isArray(value)) return [];
  const keys = [...new Set(value.filter(entry => typeof entry === "string" && SEEN_KEY.test(entry)))];
  return keys.slice(-MAX_SEEN);
}

/** The person's choices; both surfaces start on only on macOS, where the island hugs the notch. The island is a macOS
 * surface only: elsewhere it stays off and Settings does not offer it. */
export function parsePrefs(raw, platform = process.platform) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const on = platform === "darwin";
  return {
    island: on && (typeof record.island === "boolean" ? record.island : AMBIENT_DEFAULTS.island),
    dock: typeof record.dock === "boolean" ? record.dock : on && AMBIENT_DEFAULTS.dock,
    size: ISLAND_SIZE_IDS.includes(record.size) ? record.size : AMBIENT_DEFAULTS.size,
    display: DISPLAY_CHOICES.includes(record.display) ? record.display : AMBIENT_DEFAULTS.display,
    order: Array.isArray(record.order) ? [...new Set(record.order.filter(entry => id(entry)))].slice(0, 200) : [],
    seen: seenKeys(record.seen),
  };
}

/** A change from Settings or the dock, applied over the saved choices; unknown fields and bad values are ignored. */
export function applyPrefsChange(prefs, change, platform = process.platform) {
  if (!change || typeof change !== "object") return prefs;
  // what was seen comes from the surfaces themselves (ambient-main.mjs), never from Settings
  return parsePrefs({ ...prefs, ...Object.fromEntries(Object.entries(change).filter(([key]) => key in AMBIENT_DEFAULTS && key !== "seen")) }, platform);
}
