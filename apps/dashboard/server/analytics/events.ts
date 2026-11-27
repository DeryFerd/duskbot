// The product analytics catalogue: which events exist, who may send them, and the only properties each may carry.
// Events hold counts, states, platforms and versions; never message content, prompts, files, emails, IPs or tokens.
import { CANCEL_ANSWERS, RETENTION_OUTCOMES, RETENTION_STEPS } from "../../../../shared/billing-api.ts";
import { cleanSignal, isSignalName } from "../../../../shared/product-signals.ts";

export const DAY_MS = 86_400_000;
/** raw events live this long (a TTL index in MongoDB); the daily counts in analytics_daily are kept */
export const RAW_RETENTION_DAYS = 400;
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

export type PropValue = string | number | boolean;
export type Props = Record<string, PropValue>;
type Check = (value: unknown) => value is PropValue;

const oneOf = (...values: string[]): Check => (value): value is string => typeof value === "string" && values.includes(value);
const pattern = (re: RegExp, max: number): Check => (value): value is string => typeof value === "string" && value.length <= max && re.test(value);
const count: Check = (value): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 1e12;

export const PLATFORMS = ["darwin", "win32", "linux", "ios", "android"] as const;
const platform = oneOf(...PLATFORMS);
const version = pattern(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/, 40);
/** an app route with ids replaced by :id; never a query string */
const route = pattern(/^\/[a-z0-9/:_-]{0,119}$/, 120);
const cloudStatus = pattern(/^[a-z_]{2,24}$/, 24);
const word = pattern(/^[a-z0-9_]{1,40}$/, 40);
const host = pattern(/^[a-z0-9.-]{1,80}$/, 80);
const percent: Check = (value): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;

/** what the apps may report as used: names of features, never what was in them */
export const APP_FEATURES = ["bot_created", "bot_edited", "bot_deleted", "routine_created", "routine_edited", "routine_deleted", "routine_ran", "room_created", "computer_used",
  "voice_used", "call_started", "file_uploaded", "app_connected", "cloud_opened", "chat_opened", "memory_edited", "skill_added", "webhook_created", "phone_paired",
  "search_used", "settings_opened", "settings_changed", "reaction_added", "team_imported"] as const;

/** who may send an event: the service itself, the signed-in page, or the site proxy (anonymous) */
export type EventSource = "server" | "page" | "site" | "app";
export interface EventSpec {
  source: EventSource; props: Record<string, Check>; /** counts toward a person's daily activity */ active?: boolean;
  /** keys beyond `props` an event may carry: up to MAX_EXTRA, each a short lowercase key with a word, count or boolean */
  extra?: true;
}
export const MAX_EXTRA = 8;
const EXTRA_KEY = /^[a-z][a-z_]{0,19}$/;
const flag: Check = (value): value is boolean => typeof value === "boolean";
const score: Check = (value): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5;

export const EVENTS = {
  signup: { source: "server", props: { method: oneOf("email", "google", "apple") }, active: true },
  sign_in: { source: "server", props: { kind: oneOf("web", "desktop", "mobile"), platform, appVersion: version }, active: true },
  /** the desktop or phone app signed in to the account, or a workspace was connected to it */
  app_paired: { source: "server", props: { via: oneOf("app", "workspace"), platform, kind: oneOf("mac", "vps", "linux", "windows") }, active: true },
  /** an app session was used today (the app's session refresh is the heartbeat); once per device a day */
  app_active: { source: "server", props: { platform, appVersion: version }, active: true },
  cloud_state: { source: "server", props: { cloudId: pattern(/^c[0-9a-f]{24}$/, 25), kind: pattern(/^[a-z_]{2,20}$/, 20), region: pattern(/^[a-z0-9-]{1,20}$/, 20), from: cloudStatus, to: cloudStatus } },
  /** the first time any of the account's workspaces reported a bot turn */
  first_bot_reply: { source: "server", props: {} },
  checkout_paid: { source: "server", props: { amountCents: count } },
  /** a billing ledger row (billing/ledger.ts): paid, renewed, failed, refunded, disputed, cancelled, upgraded, downgraded */
  billing: { source: "server", props: { type: pattern(/^[a-z_]{2,24}\.[a-z_]{2,24}$/, 49), amountCents: count, mrrCents: count, previousMrrCents: count, plan: word, interval: oneOf("month", "year") } },
  /** a step of the dashboard's cancel flow: why, and whether it ended in a save or the cancel */
  cancel_flow: { source: "server", props: { reason: oneOf(...CANCEL_ANSWERS), step: oneOf(...RETENTION_STEPS), outcome: oneOf(...RETENTION_OUTCOMES) } },
  page_view: { source: "page", props: { path: route }, active: true },
  /** an account page view's end: its visible time; sent on the next route or when the page goes away */
  page_leave: { source: "page", props: { path: route, ms: count } },
  /** ms is the time spent on the step before this one */
  onboarding_step: { source: "page", props: { step: oneOf("name", "plan", "app"), ms: count, from: oneOf("app"), skipped: flag }, active: true },
  /** onboarding's last step sent someone who signed up from the desktop app back to it: the cloud sheet or the app as it was */
  app_return: { source: "page", props: { link: oneOf("open", "cloud"), how: oneOf("auto", "button") }, active: true },
  /** ms is the time spent on the last step */
  onboarding_done: { source: "page", props: { ms: count }, active: true },
  plan_chosen: { source: "page", props: { plan: pattern(/^[a-z_]{2,20}$/, 20), period: oneOf("month", "year") }, active: true },
  /** a download picked on onboarding's last step, and the system the page guessed the visitor is on */
  download_click: { source: "page", props: { platform: oneOf("macos", "windows", "linux", "android", "ios"), detected_os: oneOf("macos", "windows", "linux", "android", "ios", "unknown") }, active: true },
  /** a button or link on an account page: label is its static name, value a choice like a platform or an app slug; ms an
   * upsell step's visible time since it was shown (shared/cloud-upsell.ts) */
  page_action: { source: "page", props: { action: word, path: route, label: word, value: word, ms: count }, active: true },
  site_view: { source: "site", props: { path: route } },
  /** section is the landing section it happened in, label the clicked thing's name, value a choice (a platform, a period) */
  site_goal: { source: "site", props: { goal: word, to: route, from: route, host, section: word, label: word, value: word } },
  /** a landing section that was at least half on screen, and for how long in total */
  site_section: { source: "site", props: { path: route, section: word, ms: count } },
  /** a page view's end: deepest scroll, visible time and how many screens tall the page was */
  site_leave: { source: "site", props: { path: route, scroll: percent, ms: count, folds: count } },
  /** a site visitor or an app install became this account */
  identify: { source: "server", props: { via: oneOf("page", "app") } },
  app_open: { source: "app", props: { kind: oneOf("desktop", "mobile"), platform, appVersion: version }, active: true },
  app_close: { source: "app", props: { ms: count } },
  /** a screen as a virtual path, like /bots/:id */
  app_screen: { source: "app", props: { screen: route }, active: true },
  app_feature: { source: "app", props: { feature: oneOf(...APP_FEATURES) }, active: true },
  /** counts since the last send; latency is the median reply time in ms */
  app_messages: { source: "app", props: { sent: count, replies: count, latencyMs: count }, active: true },
  app_error: { source: "app", props: { kind: word, code: word } },
  app_pair_failed: { source: "app", props: { reason: word } },
  /** a named moment in the app (a card shown, a step taken); name is the moment, the rest its words, counts and flags */
  app_action: { source: "app", props: { name: word }, active: true, extra: true },
  /** the in-app "how's it going?" answer, 1 to 5, and the moment it was asked at */
  app_feedback: { source: "app", props: { score, moment: word }, active: true },
} satisfies Record<string, EventSpec>;
export type EventName = keyof typeof EVENTS;
export const EVENT_NAMES = Object.keys(EVENTS) as EventName[];
export const isEventName = (value: unknown): value is EventName => typeof value === "string" && Object.hasOwn(EVENTS, value);

/** the props an event may keep: unknown keys and invalid values are dropped, never stored */
export function cleanProps(name: EventName, input: unknown): Props {
  const spec: EventSpec = EVENTS[name];
  const out: Props = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  // a named product signal keeps exactly its catalogue's keys, or only its name
  const signal = name === "app_action" ? (input as Record<string, unknown>).name : undefined;
  if (isSignalName(signal)) return { name: signal, ...cleanSignal(signal, input, "app") };
  for (const [key, check] of Object.entries(spec.props)) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined && check(value)) out[key] = value;
  }
  if (spec.extra) {
    let extra = 0;
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (extra >= MAX_EXTRA) break;
      if (Object.hasOwn(spec.props, key) || !EXTRA_KEY.test(key)) continue;
      if (word(value) || count(value) || flag(value)) { out[key] = value as PropValue; extra++; }
    }
  }
  return out;
}

/** a page path as an analytics route: lowercased, ids folded to :id, no query, at most 120 characters */
export function routeOf(raw: string): string | null {
  let path = raw.split(/[?#]/)[0] ?? "";
  try { path = decodeURIComponent(path); } catch { return null; }
  path = path.toLowerCase().replace(/\/+$/, "") || "/";
  if (!path.startsWith("/") || path.length > 200) return null;
  const parts = path.split("/").map(part => /^(?:ws|acct|ses|cmd|c)[_a-z0-9-]{8,}$/i.test(part) || /\d{3,}/.test(part) || part.length > 32 ? ":id" : part);
  const out = parts.join("/").replace(/[^a-z0-9/:_-]/g, "").slice(0, 120);
  return /^\/[a-z0-9/:_-]{0,119}$/.test(out) ? out : null;
}
