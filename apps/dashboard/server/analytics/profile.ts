// One person's story for the admin profile: their raw events turned into readable steps, grouped into sessions
// (30 minutes of quiet starts a new one), with where they first came from, what they paid and how long that took.
// Pure functions; the admin route hands them the person's events and billing records.
import { UPSELL_EVENTS } from "../../../../shared/cloud-upsell.ts";
import { BILLING_CONFIG } from "../billing/plans.ts";
import type { StoredEvent } from "./sink.ts";
import type { Payment } from "./revenue.ts";
import type { Visit } from "./web.ts";

export const SESSION_GAP_MS = 30 * 60_000;

export type StepKind = "view" | "goal" | "paid" | "refund" | "checkout" | "signup" | "signin" | "onboarding" | "plan" | "paired" | "install" | "app"
  | "reply" | "cloud" | "upsell" | "notice" | "error" | "feedback" | "returned" | "billing";
export type StepSurface = "site" | "account" | "app" | "server";
export interface Step {
  at: number; kind: StepKind; surface: StepSurface;
  /** what happened in a few words; a goal's own name stays snake_case so it reads like the event. An upsell's is its event
   * (upsell_shown, upsell_click, upsell_dismiss, upsell_ignored) with its source as detail; a notice's is notice_closed,
   * notice_acted or notice_ignored with the notice as detail */
  name: string;
  /** the page or app screen it happened on */
  path: string | null;
  /** a short qualifier: a platform, a plan period, a checkout source */
  detail: string | null;
  amountCents: number | null;
  /** on a payment or refund: the tax on top of `amountCents` (prices are tax exclusive), when there was any */
  taxCents?: number;
  /** for `returned`: the quiet time before this session */
  gapMs?: number;
  /** visible time: on a page view, how long it was looked at; on an upsell or notice, from shown to this step; on an
   * onboarding step, the time spent on the step before; absent when not reported */
  ms?: number;
  /** a site page view's deepest scroll, only for pages at least two screens tall */
  scroll?: number;
  /** a money moment's mark: 💰 paid, 🔁 renewed, ⚠️ failed, ↩️ refunded, 👋 cancelled, 📈 upgraded, 📉 downgraded */
  emoji?: string;
}
export interface Session {
  start: number; end: number; ms: number; surface: StepSurface;
  /** where the visit came from, from its first page view; null for app and billing-only sessions */
  source: string | null; channel: string | null; campaign: string | null; referrer: string | null;
  /** newest first */
  steps: Step[];
}
export interface CheckoutLike { createdAt: number; amountCents: number; source: string | null }

const str = (value: unknown) => typeof value === "string" && value ? value : null;
const words = (value: unknown) => str(value)?.replace(/_/g, " ") ?? null;
const UPSELL = new Set<string>(Object.values(UPSELL_EVENTS));
const NOTICE = new Set(["notice_closed", "notice_ignored"]);
const msOf = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? { ms: Math.round(value) } : {};
/** a notice id as words, without its version: cloud_trial_intro_v1 reads "cloud trial intro" */
const noticeWords = (value: unknown) => words(str(value)?.replace(/_v\d+$/, ""));
/** app actions that describe the install, not something the person did */
const QUIET_ACTIONS = new Set(["env"]);
const OS_OF: Record<string, string> = { darwin: "mac", win32: "windows", linux: "linux", ios: "ios", android: "android" };

const step = (event: StoredEvent, kind: StepKind, surface: StepSurface, name: string, extra: Partial<Step> = {}): Step =>
  ({ at: event.at, kind, surface, name, path: null, detail: null, amountCents: null, ...extra });

/** what one stored event reads as on the timeline; null for bookkeeping events (page ends, section times, links, heartbeats) */
export function stepOf(event: StoredEvent): Step | null {
  const p = event.props, page = str(event.ctx?.page);
  switch (event.name) {
    case "site_view": return step(event, "view", "site", "page view", { path: str(p.path) ?? page ?? "/" });
    case "page_view": {
      const path = str(p.path) ?? "/";
      return step(event, "view", "account", "page view", { path: `/dashboard${path === "/" ? "" : path}` });
    }
    case "app_screen": return step(event, "view", "app", "app screen", { path: str(p.screen) ?? page ?? "/" });
    case "site_goal": {
      const goal = str(p.goal) ?? "goal";
      const at = str(p.from) ?? page;
      if (goal === "js_error") return step(event, "error", "site", "page error", { path: at, detail: str(p.label) });
      return step(event, "goal", "site", goal === "click" && str(p.label) ? str(p.label)! : goal, { path: at, detail: str(p.value) ?? (goal === "outbound" ? str(p.host) : null) });
    }
    case "page_action": {
      const action = str(p.action) ?? "click", path = str(p.path), label = str(p.label), value = str(p.value);
      const where = path ? `/dashboard${path === "/" ? "" : path}` : null;
      if (UPSELL.has(action)) return step(event, "upsell", "account", action, { path: where, detail: label, ...msOf(p.ms) });
      if (action === "js_error") return step(event, "error", "account", "page error", { path: where, detail: label });
      if (action === "download") return step(event, "goal", "account", "download_click", { path: where, detail: value });
      if (action === "choose") return step(event, "goal", "account", label ?? "choice", { path: where, detail: value });
      return step(event, "goal", "account", label ?? action, { path: where, detail: value });
    }
    case "download_click": return step(event, "goal", "account", "download_click", { path: page, detail: str(p.platform) });
    case "signup": return step(event, "signup", "server", "signed up", { detail: str(p.method) });
    case "sign_in": return step(event, "signin", "server", p.kind === "web" || !p.kind ? "signed in" : `signed in on the ${p.kind} app`, { detail: OS_OF[String(p.platform)] ?? null });
    case "onboarding_step": return step(event, "onboarding", "account", `onboarding: ${words(p.step) ?? "step"}`, { ...msOf(p.ms), ...(p.skipped === true ? { detail: "skipped, name came from sign-in" } : p.from === "app" ? { detail: "from the app" } : {}) });
    case "app_return": return step(event, "onboarding", "account", "sent back to the app", { detail: p.link === "cloud" ? "cloud sheet" : null });
    case "onboarding_done": return step(event, "onboarding", "account", "finished onboarding", msOf(p.ms));
    case "plan_chosen": return step(event, "plan", "account", `picked ${words(p.plan) ?? "a plan"}`, { detail: p.period === "year" ? "yearly" : p.period === "month" ? "monthly" : null });
    case "app_paired": return p.via === "workspace"
      ? step(event, "paired", "server", "connected a computer", { detail: str(p.kind) })
      : step(event, "paired", "server", "app paired", { detail: OS_OF[String(p.platform)] ?? null });
    case "app_open": return step(event, "app", "app", `opened the ${p.kind === "mobile" ? "phone" : "desktop"} app`, { detail: OS_OF[String(p.platform ?? event.ctx?.app?.platform)] ?? null });
    case "app_feature": return step(event, "app", "app", words(p.feature) ?? "used a feature");
    case "app_messages": {
      const sent = Number(p.sent) || 0, replies = Number(p.replies) || 0;
      return step(event, "app", "app", `${sent} message${sent === 1 ? "" : "s"}, ${replies} repl${replies === 1 ? "y" : "ies"}`);
    }
    case "app_error": return step(event, "error", "app", "app error", { detail: [str(p.kind), str(p.code)].filter(Boolean).join(" ") || null });
    case "app_pair_failed": return step(event, "error", "app", "pairing failed", { detail: words(p.reason) });
    case "app_action": {
      const name = str(p.name);
      if (!name || QUIET_ACTIONS.has(name)) return null;
      if (name === "account_sign_in") return step(event, "onboarding", "app", p.step === "back" ? "back in the app" : `account sign-in: ${words(p.step) ?? "step"}`, { detail: str(p.method) ?? (p.link === "cloud" ? "cloud sheet" : null) });
      if (UPSELL.has(name)) return step(event, "upsell", "app", name, { path: page, detail: str(p.source), ...msOf(p.ms) });
      if (NOTICE.has(name)) return step(event, "notice", "app", p.acted === true ? "notice_acted" : name, { detail: noticeWords(p.notice), ...msOf(p.ms) });
      return step(event, "goal", "app", name, { path: page, detail: str(p.action) ?? str(p.result) ?? str(p.variant), ...msOf(p.ms) });
    }
    case "app_feedback": return step(event, "feedback", "app", `rated it ${p.score}/5`, { detail: words(p.moment) });
    case "first_bot_reply": return step(event, "reply", "server", "first bot reply");
    case "cloud_state": {
      const to = str(p.to) ?? "changed";
      const name = p.from === "new" ? "cloud created" : to === "running" ? "cloud running" : to === "deleted" || to === "destroyed" ? "cloud deleted" : `cloud ${words(to)}`;
      // the cloud's plan by name (shared_s is plus), not its internal kind
      const plan = str(p.kind) ? (BILLING_CONFIG.desktops as Record<string, { label: string } | undefined>)[String(p.kind)]?.label.toLowerCase() ?? words(p.kind) : null;
      return step(event, "cloud", "server", name, { detail: plan ? `${plan} plan` : null });
    }
    case "checkout_paid": return step(event, "paid", "server", "paid", { amountCents: Number(p.amountCents) || 0 });
    default: return null;
  }
}

const PAY_NAME: Record<Payment["kind"], string> = { new: "paid", renewal: "renewed", one_time: "paid", refund: "refunded" };
/** billing records as steps: each payment and refund, and each checkout that was started */
export function billingSteps(payments: readonly Payment[], checkouts: readonly CheckoutLike[]): Step[] {
  return [
    ...checkouts.map((checkout): Step => ({ at: checkout.createdAt, kind: "checkout", surface: "server", name: "started checkout", path: null, emoji: "🛒", detail: words(checkout.source), amountCents: checkout.amountCents || null })),
    ...payments.map((payment): Step => ({ at: payment.at, kind: payment.kind === "refund" ? "refund" : "paid", surface: "server", name: PAY_NAME[payment.kind], path: null,
      emoji: payment.kind === "refund" ? "↩️" : payment.kind === "renewal" ? "🔁" : "💰",
      detail: payment.kind === "renewal" ? "renewal" : payment.kind === "one_time" ? "one time" : null, amountCents: payment.amountCents, ...(payment.taxCents ? { taxCents: payment.taxCents } : {}) })),
  ];
}

/** an upsell that was shown and then clicked, dismissed or left this long after still reads as one moment */
export const UPSELL_PAIR_MS = 12 * 3_600_000;
const upsellOf = (event: StoredEvent) => {
  const page = event.name === "page_action", step = str(page ? event.props.action : event.name === "app_action" ? event.props.name : null);
  const source = str(page ? event.props.label : event.props.source);
  return step && UPSELL.has(step) && source ? { step, key: `${event.name}|${source}|${event.ctx?.install ?? event.ctx?.session ?? event.ctx?.visitor ?? ""}` } : null;
};

/** what a page view's end and an upsell's outcome add to the timeline, so it does not double up: a site page's end
 * (site_leave, by page view id) and an account page's (page_leave, the latest view of that path in its visit) give the view
 * row its visible time and scroll; an upsell shown and then clicked, dismissed or ignored is one row, the outcome's */
export function readsOf(events: readonly StoredEvent[]): { skip: Set<StoredEvent>; extra: Map<StoredEvent, Partial<Step>> } {
  const skip = new Set<StoredEvent>(), extra = new Map<StoredEvent, Partial<Step>>();
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const leaves = new Map<string, { ms: number; scroll: number; folds: number }>();
  for (const event of sorted) {
    if (event.name !== "site_leave" || !event.ctx?.pv) continue;
    const prev = leaves.get(event.ctx.pv), p = event.props;
    leaves.set(event.ctx.pv, { ms: Math.max(prev?.ms ?? 0, Number(p.ms) || 0), scroll: Math.max(prev?.scroll ?? 0, Number(p.scroll) || 0), folds: Math.max(prev?.folds ?? 0, Number(p.folds) || 0) });
  }
  const views = new Map<string, StoredEvent>(), shown = new Map<string, StoredEvent>();
  for (const event of sorted) {
    if (event.name === "site_view" && event.ctx?.pv) {
      const leave = leaves.get(event.ctx.pv);
      if (leave && leave.ms > 0) extra.set(event, { ms: leave.ms, ...(leave.folds >= 2 ? { scroll: leave.scroll } : {}) });
    } else if (event.name === "page_view") views.set(`${event.ctx?.session ?? event.accountId ?? ""}|${event.props.path}`, event);
    else if (event.name === "page_leave") {
      const key = `${event.ctx?.session ?? event.accountId ?? ""}|${event.props.path}`, view = views.get(key);
      if (view && typeof event.props.ms === "number") { extra.set(view, { ms: event.props.ms }); views.delete(key); }
    } else {
      const upsell = upsellOf(event);
      if (!upsell) continue;
      if (upsell.step === UPSELL_EVENTS.shown) { shown.set(upsell.key, event); continue; }
      const before = shown.get(upsell.key);
      if (before && event.at - before.at <= UPSELL_PAIR_MS) skip.add(before);
      shown.delete(upsell.key);
    }
  }
  return { skip, extra };
}

const RANK: Record<StepSurface, number> = { site: 0, account: 1, app: 2, server: 3 };
/** the person's activity as sessions, newest first: events and billing steps sorted together, a new session after 30 quiet
 * minutes. A session's length runs from its first to its last event, page ends included, or an app's own open time if longer. */
export function sessionsOf(events: readonly StoredEvent[], extra: readonly Step[] = []): Session[] {
  type Mark = { at: number; event: StoredEvent | null; step: Step | null };
  const reads = readsOf(events);
  const stepWithReads = (event: StoredEvent) => {
    const found = reads.skip.has(event) ? null : stepOf(event), more = reads.extra.get(event);
    return found && more ? { ...found, ...more } : found;
  };
  const marks: Mark[] = [...events.map(event => ({ at: event.at, event, step: stepWithReads(event) })), ...extra.map(item => ({ at: item.at, event: null, step: item }))]
    .sort((a, b) => a.at - b.at);
  const drafts: Array<{ start: number; end: number; open: number; touch: StoredEvent | null; steps: Step[] }> = [];
  let current: (typeof drafts)[number] | null = null;
  for (const mark of marks) {
    if (!current || mark.at - current.end > SESSION_GAP_MS) { current = { start: mark.at, end: mark.at, open: 0, touch: null, steps: [] }; drafts.push(current); }
    current.end = Math.max(current.end, mark.at);
    const event = mark.event;
    if (event?.name === "app_close" && typeof event.props.ms === "number") current.open = Math.max(current.open, event.props.ms);
    if (event && !current.touch && (event.name === "site_view" || event.name === "page_view") && event.ctx?.source) current.touch = event;
    if (mark.step) current.steps.push(mark.step);
  }
  const out: Session[] = [];
  let previousEnd: number | null = null;
  for (const draft of drafts) {
    if (!draft.steps.length) continue;
    const surface = draft.steps.reduce<StepSurface>((best, item) => RANK[item.surface] < RANK[best] ? item.surface : best, "server");
    const steps = [...draft.steps];
    const start = steps[0]!.at;
    if (surface !== "server") {
      if (previousEnd !== null) steps.unshift({ at: start, kind: "returned", surface, name: "returned", path: null, detail: null, amountCents: null, gapMs: start - previousEnd });
      previousEnd = draft.end;
    }
    const ctx = draft.touch?.ctx;
    out.push({ start, end: draft.end, ms: Math.max(draft.end - start, draft.open), surface,
      source: ctx?.source ?? (surface === "site" || surface === "account" ? "direct" : null), channel: ctx?.channel ?? (surface === "site" || surface === "account" ? "direct" : null),
      campaign: ctx?.utm?.campaign ?? null, referrer: ctx?.referrer ?? null, steps: steps.reverse() });
  }
  return out.reverse();
}

export interface FirstSource { at: number; source: string; channel: string; campaign: string | null; referrer: string | null; ref: string | null }
/** where the person first came from: the earliest site visit's attribution (UTM, ?ref or referrer), else the earliest account-page visit's */
export function firstSourceOf(visits: readonly Visit[]): FirstSource | null {
  const sorted = [...visits].sort((a, b) => a.start - b.start);
  const first = sorted.find(visit => visit.surface === "site") ?? sorted.find(visit => visit.surface === "account") ?? null;
  return first ? { at: first.start, source: first.source, channel: first.channel, campaign: first.campaign, referrer: first.referrer, ref: first.ref } : null;
}

export interface Spend { spentCents: number; refundedCents: number; payments: number; firstPaidAt: number | null }
/** what the person paid: net of refunds, and when they first paid (a granted plan counts as a first payment when nothing was charged) */
export function spendOf(payments: readonly Payment[], grantedAt: number | null = null): Spend {
  const paid = payments.filter(payment => payment.amountCents > 0), refunds = payments.filter(payment => payment.amountCents < 0);
  const firstPaidAt = paid.length ? Math.min(...paid.map(payment => payment.at)) : grantedAt;
  return { spentCents: payments.reduce((sum, payment) => sum + payment.amountCents, 0), refundedCents: -refunds.reduce((sum, payment) => sum + payment.amountCents, 0),
    payments: paid.length, firstPaidAt };
}
/** from the person's first recorded moment to their first payment; null when they have not paid */
export const timeToPayOf = (firstSeen: number | null, firstPaidAt: number | null) => firstSeen !== null && firstPaidAt !== null ? Math.max(0, firstPaidAt - firstSeen) : null;

export interface Where { device: string | null; os: string | null; browser: string | null; country: string | null; region: string | null; city: string | null }
/** what the person is on now: their latest site or account visit, else their latest app (a phone or a computer) */
export function whereOf(events: readonly StoredEvent[]): Where {
  const out: Where = { device: null, os: null, browser: null, country: null, region: null, city: null };
  const newest = [...events].sort((a, b) => b.at - a.at);
  const browser = newest.find(event => event.ctx?.device);
  if (browser?.ctx) Object.assign(out, { device: browser.ctx.device ?? null, os: browser.ctx.os ?? null, browser: browser.ctx.browser ?? null });
  else {
    const app = newest.find(event => event.ctx?.app?.platform && OS_OF[event.ctx.app.platform]);
    const os = app ? OS_OF[app.ctx!.app!.platform!]! : null;
    if (os) Object.assign(out, { device: os === "ios" || os === "android" ? "mobile" : "desktop", os });
  }
  const place = newest.find(event => event.ctx?.country);
  if (place?.ctx) Object.assign(out, { country: place.ctx.country ?? null, region: place.ctx.region ?? null, city: place.ctx.city ?? null });
  return out;
}
