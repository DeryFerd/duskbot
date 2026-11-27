// A bot's `freshSession`: its direct chats start a fresh session by themselves, as Hermes Agent's session reset policy
// does ("daily" at 4 am, or after so many idle minutes). Silent: the chat stays, memory carries over and session_search
// still finds the earlier messages; only /new, the person's own, says so.
import { COMPACT_AT_MAX, COMPACT_AT_MIN, FRESH_SESSION_MAX_IDLE_HOURS, type FreshSession } from "../shared/wire.ts";

/** Where a new day starts, in the person's time zone: a chat that runs past midnight is still the same evening's. */
export const FRESH_DAY_STARTS_AT_HOUR = 4;

/** The policy from a request body: undefined when none was sent, null to clear it, an error message when unusable. */
export function parseFreshSession(value: unknown): FreshSession | null | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const error = { error: `freshSession must be null, { "every": "day" } or { "idleHours": up to ${FRESH_SESSION_MAX_IDLE_HOURS} }` };
  if (!value || typeof value !== "object" || Array.isArray(value)) return error;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length === 1 && body.every === "day") return { every: "day" };
  const hours = body.idleHours;
  if (keys.length === 1 && typeof hours === "number" && Number.isFinite(hours) && hours > 0 && hours <= FRESH_SESSION_MAX_IDLE_HOURS) return { idleHours: hours };
  return error;
}

export function parseCompactAt(value: unknown): number | null | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= COMPACT_AT_MIN && value <= COMPACT_AT_MAX) return value;
  return { error: `compactAt must be null or a fraction from ${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}` };
}

function dayOf(at: number, timeZone: string): string {
  const shifted = at - FRESH_DAY_STARTS_AT_HOUR * 3_600_000;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
  }
}

/** Whether the person's message at `now` starts a fresh session, given when they last wrote in the chat. */
export function freshSessionDue(policy: FreshSession | undefined, previousAt: number | undefined, now: number, timeZone: string): "day" | "idle" | null {
  if (!policy || previousAt === undefined || !(now > previousAt)) return null;
  if ("every" in policy) return dayOf(previousAt, timeZone) !== dayOf(now, timeZone) ? "day" : null;
  return now - previousAt >= policy.idleHours * 3_600_000 ? "idle" : null;
}

/** Where the bot's context starts over: at the person's new message. `previousAt`: when they last wrote before it;
 * `foldedThroughId`: the last line the model would otherwise have read (`inContext`); `started`: a fresh session already
 * starts at this message, as when its turn is retried. */
export function freshSessionStart<M extends { id: string; role: string; at: number; peerAsk?: unknown; compaction?: { fresh?: string; firstKeptId: string } }>(
  messages: readonly M[], messageId: string, inContext: (message: M) => boolean,
): { previousAt?: number; foldedThroughId?: string; started: boolean } {
  const index = messages.findIndex((message) => message.id === messageId);
  const started = messages.some((message) => Boolean(message.compaction?.fresh) && message.compaction?.firstKeptId === messageId);
  if (index <= 0) return { started };
  const before = messages.slice(0, index);
  return {
    previousAt: before.findLast((message) => message.role === "user" && !message.peerAsk)?.at,
    foldedThroughId: before.findLast(inContext)?.id,
    started,
  };
}
