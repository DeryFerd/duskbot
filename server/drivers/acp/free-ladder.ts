// The free backup's fallback ladder: the free models a turn steps through when one is busy, rate limited, failing or
// silent. A rung that just failed cools down for a few minutes so the next turns skip it; a rung that just answered
// (a turn or the start-up probe) goes first. In memory only: a restart starts over, and the start-up probe refills it.
import type { ModelCatalog } from "../../contracts.ts";
import { trail } from "../../trail.ts";

export interface FreeRung { model: string; variant?: string }

/** How long a failing free model is skipped. */
export const FREE_RUNG_COOL_MS = 5 * 60_000;
/** How long a free model that just answered is tried first. */
export const FREE_RUNG_WARM_MS = 10 * 60_000;
/** The start-up probe's question and how long one rung may take over it, engine start included. */
export const FREE_PROBE_PROMPT = "Reply with the single word: ready";
export const FREE_PROBE_MS = 15_000;
/** The lighter reasoning settings a fallback rung runs at, first one offered wins: a quicker first word. */
const LIGHT_VARIANTS = ["low", "minimal"] as const;

/** Zen's free limit (FreeUsageLimitError, HTTP 429): a daily request count per IP address that resets at midnight UTC.
 * Models Zen gives a limit of their own count apart, keyed by the first two letters of their Zen id; every other free
 * model shares one count (Zen's console ipRateLimiter, read 2026-11-27; on 2026-11-14 all twelve free models answered
 * the limit at once). Any other 429 is one model's. */
export const FREE_POOL_LIMIT = /FreeUsageLimitError|free usage limit/i;

export type FreeFailure = "pool_limit" | "rate_limited" | "busy" | "timeout" | "empty" | "unavailable" | "error";
/** How long a model its provider says it no longer serves is skipped. */
export const FREE_RUNG_GONE_MS = 6 * 60 * 60_000;
/** How long a model that answered the free limit is skipped. Shorter than the limit's day: a computer that moved to
 * another network has a fresh count, and one look costs a single fast refusal. */
export const FREE_RUNG_LIMIT_MS = 30 * 60_000;
/** The free models a turn tries after the free limit refused one, each counted apart by Zen or not. */
export const FREE_LIMIT_TRIES = 3;

/** The count Zen's free limit keeps for this model: the first two letters of its Zen id. */
export function freeLimitBucket(model: string): string {
  const bare = model.startsWith("opencode/") ? model.slice("opencode/".length) : model;
  return bare.slice(0, 2).toLowerCase();
}

const cooling = new Map<string, { until: number; reason: FreeFailure }>();
let warm: { model: string; variant?: string; until: number } | null = null;

export function lightVariant(variants: readonly { id: string }[] | undefined): string | undefined {
  return LIGHT_VARIANTS.find((id) => variants?.some((variant) => variant.id === id));
}

/** The variant a model advertises: keep a supported choice, else its own default, else none. */
export function advertisedVariant(variants: readonly { id: string }[] | undefined, preferred: string | undefined): string | undefined {
  if (preferred === undefined || !variants) return preferred;
  if (variants.some((variant) => variant.id === preferred)) return preferred;
  return variants.some((variant) => variant.id === "default") ? "default" : undefined;
}

/** Why a free model failed, from its error or the provider error OpenCode logged for it. */
export function freeFailure(message: string, flags: { limit?: boolean; empty?: boolean; silent?: boolean } = {}): FreeFailure {
  if (flags.limit || FREE_POOL_LIMIT.test(message)) return "pool_limit";
  if (flags.empty) return "empty";
  if (/no longer (?:available|supported|served)|model (?:not found|does not exist)|unknown model|\b(?:404|410)\b/i.test(message)) return "unavailable";
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return "rate_limited";
  if (/\b5\d\d\b|overloaded|unavailable|capacity|busy|bad gateway|internal server error/i.test(message)) return "busy";
  if (flags.silent || /time[sd]? ?out/i.test(message)) return "timeout";
  return "error";
}

export function coolFreeRung(model: string, reason: FreeFailure, now = Date.now()): void {
  const ms = reason === "unavailable" ? FREE_RUNG_GONE_MS : reason === "pool_limit" ? FREE_RUNG_LIMIT_MS : FREE_RUNG_COOL_MS;
  cooling.set(model, { until: now + ms, reason });
  if (warm?.model === model) warm = null;
}

/** The model answered the free limit within its cool-down. */
export function freeRungLimited(model: string, now = Date.now()): boolean {
  return freeRungCooling(model, now) && cooling.get(model)?.reason === "pool_limit";
}

/** Every rung answered the free limit within its cool-down: a call can only be refused again. */
export function freeLadderLimited(ladder: readonly FreeRung[], now = Date.now()): boolean {
  return ladder.length > 0 && ladder.every((rung) => freeRungLimited(rung.model, now));
}

/** The rung a turn moves to after `tried` failed. After the free limit, only a model whose count Zen may keep apart (a
 * bucket no tried model hit the limit in), at most FREE_LIMIT_TRIES of them; never a model known to be at the limit. */
export function nextFreeRung(ladder: readonly FreeRung[], tried: readonly string[], now = Date.now()): FreeRung | undefined {
  const limited = tried.filter((model) => freeRungLimited(model, now));
  const spent = new Set(limited.map(freeLimitBucket));
  if (limited.length > FREE_LIMIT_TRIES) return undefined;
  return ladder.find((rung) => !tried.includes(rung.model) && !freeRungLimited(rung.model, now) && !spent.has(freeLimitBucket(rung.model)));
}

export function warmFreeRung(rung: FreeRung, now = Date.now()): void {
  cooling.delete(rung.model);
  warm = { ...rung, until: now + FREE_RUNG_WARM_MS };
}

export function freeRungCooling(model: string, now = Date.now()): boolean {
  const entry = cooling.get(model);
  if (entry && entry.until <= now) cooling.delete(model);
  return Boolean(entry && entry.until > now);
}

export function warmFreeModel(now = Date.now()): FreeRung | null {
  if (warm && warm.until <= now) warm = null;
  return warm ? { model: warm.model, ...(warm.variant ? { variant: warm.variant } : {}) } : null;
}

/** The rungs a turn on `current` steps through: the turn's own model as asked, then the last model that answered, then
 * every other free model of `order` at its lighter reasoning setting. Cooling rungs go last, soonest-ready first, so they
 * are skipped while another rung is left yet a turn is never left with nothing to try. */
export function freeLadder(current: FreeRung, order: readonly string[], models: ModelCatalog, now = Date.now()): FreeRung[] {
  const variantsOf = (model: string) => models.options.find((option) => option.id === model)?.variants;
  const seen = new Set<string>();
  const rungs: FreeRung[] = [];
  const add = (rung: FreeRung) => {
    if (seen.has(rung.model)) return;
    seen.add(rung.model);
    rungs.push(rung);
  };
  add(current);
  const hot = warmFreeModel(now);
  if (hot && order.includes(hot.model)) add(hot);
  for (const model of order) {
    const variant = lightVariant(variantsOf(model));
    add({ model, ...(variant ? { variant } : {}) });
  }
  const ready = rungs.filter((rung) => !freeRungCooling(rung.model, now));
  const cold = rungs.filter((rung) => freeRungCooling(rung.model, now))
    .sort((a, b) => cooling.get(a.model)!.until - cooling.get(b.model)!.until);
  return [...ready, ...cold];
}

/** For tests and a fresh sign-in. */
export function resetFreeLadder(): void {
  cooling.clear();
  warm = null;
}

/** Past this much more wall time than the call's own clock or its time limit, the computer slept or the app was frozen
 * (a locked screen) during the call, so a timeout says nothing about the model. */
const SUSPEND_SLACK_MS = 10_000;

/** Whether a call that ran from `wall`/`mono` to now spanned a suspend: wall time ran on while the monotonic clock
 * (which stops in sleep) did not, or the call outran its limit by far more than a late timer can. */
export function spannedSuspend(started: { wall: number; mono: number }, ended: { wall: number; mono: number }, limitMs: number): boolean {
  const wallMs = ended.wall - started.wall;
  return wallMs - (ended.mono - started.mono) > SUSPEND_SLACK_MS || wallMs > limitMs + SUSPEND_SLACK_MS;
}

/** The start-up probe: tries rungs in ladder order with a tiny prompt until one answers, so a person's first message
 * starts on a model known to answer. Stops at the first answer, a pool-wide limit, or `maxRungs`. A timeout across a
 * suspend never cools the model; that rung is asked once more instead. */
export async function probeFreeLadder(
  ladder: readonly FreeRung[],
  run: (rung: FreeRung) => Promise<unknown>,
  log: (event: { rung: FreeRung; ok: boolean; ms: number; reason?: FreeFailure; suspended?: boolean }) => void,
  { maxRungs = 3, now = Date.now, monotonic = () => performance.now(), limitMs = FREE_PROBE_MS }:
    { maxRungs?: number; now?: () => number; monotonic?: () => number; limitMs?: number } = {},
): Promise<FreeRung | null> {
  if (freeLadderLimited(ladder, now())) return null;
  let retried = false;
  const rungs = ladder.slice(0, maxRungs);
  for (let at = 0; at < rungs.length; at++) {
    const rung = rungs[at]!;
    const started = { wall: now(), mono: monotonic() };
    try {
      await run(rung);
      warmFreeRung(rung, now());
      log({ rung, ok: true, ms: now() - started.wall });
      return rung;
    } catch (error) {
      const reason = freeFailure(error instanceof Error ? error.message : String(error));
      const ms = now() - started.wall;
      if (reason === "timeout" && spannedSuspend(started, { wall: now(), mono: monotonic() }, limitMs)) {
        log({ rung, ok: false, ms, reason, suspended: true });
        if (!retried) {
          retried = true;
          at--;
        }
        continue;
      }
      coolFreeRung(rung.model, reason, now());
      log({ rung, ok: false, ms, reason });
      if (reason === "pool_limit") return null;
    }
  }
  return null;
}

/** A one-shot call (a connection check, memory upkeep) on free models: each rung is named, since an engine's own default
 * can be a model of a provider it has no access to (OpenCode 1.19 answers "Authentication required"), and a rung that
 * fails hands over to the next, up to `maxRungs` or the free limit every free model shares. */
export async function freeOneShot<T>(ladder: readonly FreeRung[], run: (rung: FreeRung) => Promise<T>, signal: AbortSignal | undefined, name: string, maxRungs = 3): Promise<T> {
  if (freeLadderLimited(ladder)) throw new Error(`${name}'s free models are at their free usage limit`);
  let failure: unknown = new Error(`${name} background call aborted`);
  for (const rung of ladder.slice(0, maxRungs)) {
    if (signal?.aborted) break;
    try {
      const answer = await run(rung);
      warmFreeRung(rung);
      return answer;
    } catch (error) {
      failure = error;
      const reason = freeFailure(error instanceof Error ? error.message : String(error));
      trail("free_model.one_shot_failed", { model: rung.model, reason });
      if (reason === "pool_limit") break;
    }
  }
  throw failure;
}
