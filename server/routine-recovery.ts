// What an unattended routine run's failure turns into: a failure starts the run once more after a short wait, unless a
// second start could only repeat or undo it (a stall the turn watchdog stopped, a stop someone pressed or typed, a
// refusal, a turn cap); a busy target is waited for, a usage limit with a known reset is waited out, and what only the
// owner can fix fails at once and is told to them once per bot and cause, until one of that bot's runs completes.
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { RoutineRetryCause } from "../shared/routines.ts";
import { failureOf, type RoutineFailedFor, type UsageReason } from "../shared/usage-signals.ts";
import { engineFailureKind, limitResetFromWords } from "./drivers/engine-errors.ts";
import { classifyError } from "./drivers/retry.ts";
import type { RoutineRun } from "./routines.ts";
import { hostTimeZone } from "./turn-clock.ts";
import { classifyContinuable } from "./turn-continuation.ts";

export type RoutineOwnerCause = "signed_out" | "credits" | "usage_limit" | "setup";

/** What is known about a failure besides its words: a cause the server words itself, and the engine's own flags. */
export interface RoutineFailureFacts {
  /** stalled: the turn watchdog stopped it; cap: a turn cap (or the repeat guard) ended it; refused: the server
   * would not start it (judged by its words, never retried as a crash); dispatch: its AI could not start the turn,
   * which starts once more when its words read as for now (an engine still starting, a network blip). */
  cause?: "stalled" | "busy" | "cap" | "refused" | "dispatch";
  stopReason?: string | null;
  setup?: boolean;
  stalled?: boolean;
  limitResetsAt?: number;
  /** A usage limit refused it (the runtime error's `limit`). */
  limit?: "engine" | "model" | "credits";
  /** A backup engine takes over from one whose usage limit refused the run, or that is signed out. */
  backupReady?: boolean;
  /** The turn's reply came back; only a step it ran failed or wasn't allowed (the runtime error's `partial`). */
  partial?: boolean;
}

export type RoutineFailureClass =
  | { kind: "retry"; cause: Exclude<RoutineRetryCause, "usage_limit"> }
  | { kind: "busy" }
  | { kind: "owner"; cause: RoutineOwnerCause; resetsAt?: number }
  | { kind: "final" };

/** A failure notification's own words; null stays quiet because the owner was already told. */
export interface RoutineAlert { detail: string }

export interface RoutineOwnerNotice { botId: string; cause: RoutineOwnerCause; at: number }

export type RoutineRecovery = { queued: true; alert?: RoutineAlert } | { queued: false; error: string; alert?: RoutineAlert | null; failedFor?: RoutineFailedFor };

const RETRY_MS = 15_000;
/** An engine that could not start, or a sign-in that just lapsed, gets a minute to come up or renew before its one retry. */
const NOT_READY_RETRY_MS = 60_000;
const RATE_LIMIT_RETRY_MS = 60_000;
export const ROUTINE_BUSY_RECHECK_MS = 30_000;
export const ROUTINE_BUSY_WAIT_MS = 60 * 60_000;
/** Past this, a usage limit fails the run instead: the routine's next scheduled runs come sooner. */
const LIMIT_WAIT_MS = 12 * 60 * 60_000;
const AFTER_RESET_MS = 60_000;
/** A usage limit that named no reset is tried again this often, so plan usage decides, not a guess. */
export const LIMIT_RECHECK_MS = 15 * 60_000;
/** Starts a run may wait on usage limits beyond its one retry, backing off from 15 minutes to an hour: about 7 hours. */
export const MAX_LIMIT_WAITS = 8;
const WEEK_MS = 7 * 24 * 60 * 60_000;
/** startTurn's codes for a bot or thread that is busy for now. */
const BUSY_CODES = new Set(["thread_busy", "thread_limit", "workspace_busy", "settling"]);
/** Stop reasons of a turn someone ended on purpose (Stop, a typed "stop", a settings change that cut it short), the AI
 * declined, or a tool call the person denied or that failed after its corrective rounds: a second start would undo or
 * repeat it. */
const NOT_RETRIED_STOPS = new Set(["cancelled", "interrupted", "refusal", "tool_error"]);
/** What the provider answered for a reason a second start would meet again. */
const REFUSED_KINDS = new Set(["refused", "tool_schema", "tool_count", "session_id"]);
const OWNER_CAUSES = new Set<RoutineOwnerCause>(["signed_out", "credits", "usage_limit", "setup"]);
/** A start that failed for one of these reasons is counted as its AI not being ready; a named one keeps its name. */
const NOT_READY_REASONS = new Set<UsageReason>(["unknown", "crashed", "cli_exit_early", "no_reply"]);
/** The words of a start that may work in a minute: an engine still starting or being changed, or one that just quit. */
const NOT_READY_WORDS = /try again (?:shortly|in a moment|soon|later)|still (?:starting|loading|being)|not ready|is starting|starting up|being updated|in progress|(?:could|did) not start|didn'?t start|before it was ready|not running|exited|closed|no response|did not answer/i;

/** A turn that could not start for now: its words read as an engine coming up or a passing network or provider error. */
export function startsLater(failure: string): boolean {
  const engine = engineFailureKind(failure);
  return NOT_READY_WORDS.test(failure) || classifyError({ text: failure }).transient || engine === "rate_limit" || engine === "overloaded" || engine === "server";
}

const OWNER_ACTION: Record<Exclude<RoutineOwnerCause, "setup">, string> = {
  signed_out: "This bot's AI is signed out. Sign in again in Settings → Models.",
  credits: "This bot's AI account is out of credit. Add credit with the provider, or choose another AI for this bot.",
  usage_limit: "This bot's AI reached its usage limit. Its routines work again once it resets, or choose another AI for this bot now.",
};
const RETRY_WHY: Record<Exclude<RoutineRetryCause, "usage_limit">, string> = {
  stalled: "the AI stalled", restarted: "dusk bot restarted while it ran", rate_limited: "a rate limit", provider: "a temporary error",
  failed: "a failure",
};
const FIRST_START: Record<RoutineRetryCause, string> = {
  stalled: "stopped when its AI stalled", restarted: "was cut off when dusk bot restarted", rate_limited: "was stopped by a rate limit",
  provider: "failed on a temporary AI error", usage_limit: "was refused by the AI's usage limit", failed: "failed",
};

/** Any failure gets one automatic retry, except a stall the turn watchdog stopped (its Chief hears instead), a
 * stop someone pressed or typed, a refusal, and a turn cap. Routine runs and teammate threads both judge by this. */
export function classifyRoutineFailure(failure: string, facts: RoutineFailureFacts = {}): RoutineFailureClass {
  if (facts.cause === "busy") return { kind: "busy" };
  if (facts.cause === "stalled" || facts.cause === "cap") return { kind: "final" };
  if (facts.stopReason && NOT_RETRIED_STOPS.has(facts.stopReason)) return { kind: "final" };
  if (classifyContinuable(facts.stopReason, failure) === "cap") return { kind: "final" };
  if (facts.stalled) return { kind: "retry", cause: "stalled" };
  const engine = engineFailureKind(failure);
  const { reason, transient } = classifyError({ text: failure });
  if (engine === "credits" && !facts.limit) return { kind: "owner", cause: "credits" };
  if (facts.limit || facts.limitResetsAt || facts.stopReason === "quota" || engine === "usage_limit") {
    return { kind: "owner", cause: "usage_limit", ...(facts.limitResetsAt ? { resetsAt: facts.limitResetsAt } : {}) };
  }
  if (facts.stopReason === "auth_required" || reason === "auth") return { kind: "owner", cause: "signed_out" };
  if (reason === "quota") return { kind: "owner", cause: "credits" };
  if (facts.setup || facts.stopReason === "update_required" || facts.stopReason === "setup_required") return { kind: "owner", cause: "setup" };
  if (engine === "rate_limit" || reason === "rate_limited") return { kind: "retry", cause: "rate_limited" };
  if (engine === "overloaded" || engine === "server" || transient) return { kind: "retry", cause: "provider" };
  if (facts.cause === "dispatch" && startsLater(failure)) return { kind: "retry", cause: "provider" };
  // A failure nothing above names (a crash, an exit before the result): one more start. A refused start or a named refusal never.
  return reason === "unknown" && facts.cause !== "refused" && facts.cause !== "dispatch" && !(engine && REFUSED_KINDS.has(engine)) ? { kind: "retry", cause: "failed" } : { kind: "final" };
}

/** Why startTurn would not start a run: busy for now or any other refusal. A start that threw
 * without a status or code (an engine that would not spawn) is a failure like any other. */
export function dispatchRefusal(error: unknown): RoutineFailureFacts {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  if (typeof code === "string" && BUSY_CODES.has(code)) return { cause: "busy" };
  return typeof code === "string" || (typeof status === "number" && status >= 400 && status < 500) ? { cause: "dispatch" } : {};
}

export function engineFacts({ setup, stalled, limitResetsAt, limit, partial }: RuntimeEvent & { type: "runtime.error" }): RoutineFailureFacts {
  return { setup, stalled, limitResetsAt, limit, partial };
}

/** Host-local, with its zone: on a Cloud home the host's zone need not be the reader's. */
function when(at: number): string {
  const timeZone = hostTimeZone();
  try {
    return `${new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })} (${timeZone})`;
  } catch {
    return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/** Queues the run's one second start; false when it already had it or is not a bot's run. */
export function requeueOnce(run: RoutineRun, cause: RoutineRetryCause, failure: string, now: number,
  at = now + (cause === "rate_limited" ? RATE_LIMIT_RETRY_MS : RETRY_MS)): boolean {
  if (run.target !== "bot" || run.retried !== undefined) return false;
  run.status = "queued";
  run.retried = cause;
  run.retryAt = at;
  run.attention = cause === "usage_limit"
    ? `Waiting for the AI's usage limit to reset; this run starts again at ${when(at)}`
    : `Starting again shortly after ${RETRY_WHY[cause]}${cause === "restarted" ? "" : `: ${failure}`}`.slice(0, 500);
  delete run.error;
  return true;
}

/** Queues the run again for its AI's usage limit: at the reset when known, else at the next recheck. Bounded by
 * MAX_LIMIT_WAITS on top of its one retry; a reset that already passed and refused again backs off. */
export function requeueForLimit(run: RoutineRun, failure: string, now: number, resetsAt: number | undefined): boolean {
  if (run.target !== "bot") return false;
  if (run.retried === undefined) {
    const at = resetsAt ? resetsAt + AFTER_RESET_MS : now + LIMIT_RECHECK_MS;
    if (!requeueOnce(run, "usage_limit", failure, now, at)) return false;
    if (!resetsAt) run.attention = `Waiting for the AI's usage limit to reset; checking again at ${when(at)}`;
    return true;
  }
  const waits = run.limitWaits ?? 0;
  if (waits >= MAX_LIMIT_WAITS) return false;
  const backoff = now + LIMIT_RECHECK_MS * Math.min(2 ** waits, 4);
  const at = Math.max(backoff, resetsAt ? resetsAt + AFTER_RESET_MS : 0);
  Object.assign(run, { status: "queued", retryAt: at, limitWaits: waits + 1,
    attention: `Still waiting for the AI's usage limit to reset; this run starts again at ${when(at)}` } satisfies Partial<RoutineRun>);
  delete run.error;
  return true;
}

/** The second start's own line, so a run that already did part of its work does not do it twice. */
export function retryNote(cause: RoutineRetryCause): string {
  return `[dusk bot: this run's first start ${FIRST_START[cause]} before it finished. If it already did part of the work, ` +
    "check what it did (files, messages sent, anything started) so nothing is done twice; then finish the routine.]";
}

function firstNotice(notices: RoutineOwnerNotice[], botId: string, cause: RoutineOwnerCause, at: number): boolean {
  if (notices.some((notice) => notice.botId === botId && notice.cause === cause)) return false;
  notices.push({ botId, cause, at });
  return true;
}

const BUSY_WAIT = "Waiting to start: ";

/** A thread's turn ended: each run queued behind it starts on the next pass instead of at its recheck. */
export function wakeBusyWaits(runs: RoutineRun[], threadId: string, now: number): boolean {
  let woke = false;
  for (const run of runs) {
    if (run.status !== "queued" || run.threadId !== threadId || !run.attention?.startsWith(BUSY_WAIT) || (run.retryAt ?? 0) <= now) continue;
    run.retryAt = now;
    woke = true;
  }
  return woke;
}

/** What a failed attempt becomes. A queued run is changed in place; a failing one is the caller's to fail with `error`. */
export function recoverRun(run: RoutineRun, failure: string, facts: RoutineFailureFacts, now: number, notices: RoutineOwnerNotice[]): RoutineRecovery {
  const verdict: RoutineFailureClass = run.target === "bot" ? classifyRoutineFailure(failure, facts) : { kind: "final" };
  const again = run.retried ? `Failed after one automatic retry: ${failure}` : failure;
  // A stall is the AI or its connection hanging for now (often a computer that slept mid-run): one more start, quietly.
  if (facts.cause === "stalled") return run.target === "bot" && requeueOnce(run, "stalled", failure, now) ? { queued: true } : { queued: false, error: again, failedFor: "stalled" };
  const notReady = facts.cause === "dispatch" && NOT_READY_REASONS.has(failureOf(failure).reason) ? { failedFor: "not_ready" as const } : {};
  if (verdict.kind === "busy") {
    run.deferredAt ??= now;
    // A run of checked items waits as long as it takes: its bot is busy with the person, which is not a failure.
    if (now - run.deferredAt >= ROUTINE_BUSY_WAIT_MS && run.checkKey === undefined) return { queued: false, error: `Did not start: still busy after ${ROUTINE_BUSY_WAIT_MS / 60_000} minutes (${failure})` };
    run.status = "queued";
    run.retryAt = now + ROUTINE_BUSY_RECHECK_MS;
    run.attention = `${BUSY_WAIT}${failure}`.slice(0, 500);
    delete run.error;
    return { queued: true };
  }
  if (verdict.kind === "retry" && verdict.cause === "failed" && !run.output) return { queued: false, error: `${failure} (not retried: it failed before doing anything)` };
  if (verdict.kind === "retry") return requeueOnce(run, verdict.cause, failure, now, facts.cause === "dispatch" ? now + NOT_READY_RETRY_MS : undefined) ? { queued: true } : { queued: false, error: again, ...notReady };
  if (verdict.kind === "final") return { queued: false, error: again, ...notReady };
  if (verdict.cause === "usage_limit" && facts.backupReady && requeueOnce(run, "usage_limit", failure, now, now + RETRY_MS)) {
    run.attention = "Starting again on the backup AI: this bot's AI reached its usage limit";
    return { queued: true };
  }
  // A signed-out AI's run starts again on the backup the person chose; its start there says once that it needs signing in.
  if (verdict.cause === "signed_out" && facts.backupReady && requeueOnce(run, "failed", failure, now, now + RETRY_MS)) {
    run.attention = "Starting again on the backup AI: this bot's AI is signed out";
    return { queued: true };
  }
  // A sign-in that just lapsed often renews on the engine's next start: one quiet retry before the owner is told.
  // An engine that says it is not signed in at all (auth_required, a setup error) is not retried: no new start signs it in.
  if (verdict.cause === "signed_out" && !facts.setup && facts.stopReason !== "auth_required" && requeueOnce(run, "provider", failure, now, now + NOT_READY_RETRY_MS)) return { queued: true };
  const first = firstNotice(notices, run.botId, verdict.cause, now);
  const named = verdict.resetsAt ?? (verdict.cause === "usage_limit" ? limitResetFromWords(failure, now) : undefined);
  const reset = named && named > now ? named : undefined;
  const pastReset = run.retried === "usage_limit" && run.limitWaits === undefined;
  if (verdict.cause === "usage_limit" && (!reset || reset - now <= LIMIT_WAIT_MS) && requeueForLimit(run, failure, now, reset)) {
    // a refusal after its wait is told even when the limit was told already: the wait did not end it
    const detail = pastReset ? `This bot's AI is still at its usage limit. This run starts again at ${when(run.retryAt!)}.`
      : first ? `This bot's AI reached its usage limit. This run starts again at ${when(run.retryAt!)}.` : undefined;
    return { queued: true, ...(detail ? { alert: { detail } } : {}) };
  }
  const action = verdict.cause === "setup" ? failure : OWNER_ACTION[verdict.cause];
  return { queued: false, error: verdict.cause === "signed_out" ? `${action} The AI said: “${failure}”` : failure, alert: first ? { detail: action } : null };
}

export function loadOwnerNotices(value: unknown): RoutineOwnerNotice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((notice) => typeof notice?.botId === "string" && OWNER_CAUSES.has(notice.cause) && Number.isFinite(notice.at)
    ? [{ botId: notice.botId, cause: notice.cause as RoutineOwnerCause, at: notice.at as number }] : []).slice(-500);
}

export function weekRuns(runs: readonly RoutineRun[], routineId: string, now: number): { ok: number; total: number } | undefined {
  let ok = 0, total = 0;
  for (const run of runs) {
    if (run.routineId !== routineId || !["completed", "failed", "missed"].includes(run.status) || (run.finishedAt ?? run.createdAt) < now - WEEK_MS) continue;
    total += 1;
    if (run.status === "completed") ok += 1;
  }
  return total ? { ok, total } : undefined;
}
