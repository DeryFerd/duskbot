// Hours away: a direct conversation the person has not written in for `context.idleCompactHours` (6 by default) is
// summarized in the background once it holds `IDLE_COMPACT_MIN_TOKENS` or more, so their next message starts lean
// instead of re-reading the whole chat with a cold prompt cache. The whole chat stays saved and searchable.
//
// Shaped on what Hermes Agent learnt (scratchpad research, compaction-research.md):
// - the clock is the person's own last message (`askedAt`): a routine's post, a teammate's report or a bot's own turn
//   never keeps a conversation "awake" (the hermes-session-reset-policy plugin's fix);
// - a background sweep finds it, so the person never waits for the summary (Hermes's old expiry watcher: 60 s, then
//   every 300 s), never while a turn, a queued message, a routine or anything else may be about to use it;
// - it summarizes instead of wiping (Hermes removed its timed wipe because people expected chats to persist); /new is the
//   wipe, by hand. What the chat taught is captured to memory first, as every fold does.
// The warm summary (server/warm-summary.ts) covers the first 50 minutes after a turn, while the prompt cache is warm.

/** Away this long, a conversation's prompt cache (an hour at most) is long cold. What Ram ran Hermes with. */
export const DEFAULT_IDLE_COMPACT_HOURS = 6;
/** Below this a summary saves little and only drops detail; at 32k most models already read worse (NoLiMa, 2025). */
export const IDLE_COMPACT_MIN_TOKENS = 32_000;
/** Only absences that began this recently are summarized ahead: a chat left for longer may never be opened again, and
 * a server that just started (or was just updated) must not summarize every old chat at once. */
export const IDLE_COMPACT_LOOKBACK_HOURS = 72;
/** Summaries per sweep, at most: the rest wait five minutes. */
export const IDLE_COMPACT_PER_SWEEP = 3;
export const IDLE_SWEEP_FIRST_MS = 60_000;

/** `context.idleCompactHours`, overridden by DUSK_IDLE_COMPACT_HOURS ("0" turns it off). */
export function idleCompactHours(configured: number | undefined, env: string | undefined): number {
  const fromEnv = env?.trim() ? Number(env) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return configured !== undefined && Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_IDLE_COMPACT_HOURS;
}
export const IDLE_SWEEP_EVERY_MS = 5 * 60_000;

export interface IdleCandidate {
  botId: string;
  threadId: string;
  /** When the person last wrote here. */
  askedAt: number;
  /** When the conversation was last summarized (a fold, or the warm summary), if ever. */
  compactedAt?: number;
}

export interface IdleCompactionDeps {
  now(): number;
  /** Hours away before a summary; 0 or less: off (and off with `context.autoCompact: false`). */
  hours(): number;
  /** Direct conversations the person last wrote in before `askedBefore`: never a room, a routine's run or a bot's own job. */
  candidates(askedBefore: number): IdleCandidate[];
  /** Why not now (a turn, a queued message, a routine running or due, a teammate at work, a fired wait), or null. */
  hold(candidate: IdleCandidate): string | null;
  /** Writes the summary: true when it did, false when the conversation is under the size floor or has nothing to fold. */
  compact(candidate: IdleCandidate, signal: AbortSignal): Promise<boolean>;
  log?(line: string): void;
  after?(ms: number, fn: () => void): { cancel(): void };
  /** A test fixture's sweep interval (DUSK_IDLE_SWEEP_MS); the first sweep and every later one. */
  sweepMs?: number;
}

export function createIdleCompaction(deps: IdleCompactionDeps) {
  const after = deps.after ?? ((ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); return { cancel: () => clearTimeout(timer) }; });
  /** threadId -> the `askedAt` already handled, done or not needed, so a chat is looked at once per absence. */
  const settled = new Map<string, number>();
  let running: { threadId: string; controller: AbortController } | null = null;
  let timer: { cancel(): void } | null = null;
  let disposed = false;

  const due = (c: IdleCandidate, now: number, hours: number) =>
    now - c.askedAt >= hours * 3_600_000 && now - c.askedAt < Math.max(hours, IDLE_COMPACT_LOOKBACK_HOURS) * 3_600_000 &&
    (c.compactedAt === undefined || c.compactedAt < c.askedAt) && settled.get(c.threadId) !== c.askedAt;

  /** One pass: summarizes the conversations that are due, one at a time, oldest absence first. */
  async function sweep(): Promise<number> {
    if (disposed || running) return 0;
    const hours = deps.hours();
    if (!(hours > 0)) return 0;
    let done = 0;
    const now = deps.now();
    const queue = deps.candidates(now - hours * 3_600_000).filter((c) => due(c, now, hours)).sort((a, b) => a.askedAt - b.askedAt);
    for (const candidate of queue) {
      if (disposed || done >= IDLE_COMPACT_PER_SWEEP) break;
      const held = deps.hold(candidate);
      // held: looked at again on the next sweep, once whatever holds it is over
      if (held) { deps.log?.(`idle compaction ${candidate.threadId}: waiting, ${held}`); continue; }
      const controller = new AbortController();
      running = { threadId: candidate.threadId, controller };
      try {
        const wrote = await deps.compact(candidate, controller.signal);
        if (!controller.signal.aborted) settled.set(candidate.threadId, candidate.askedAt);
        if (wrote) { done++; deps.log?.(`idle compaction ${candidate.threadId}: summarized after ${hours} h away`); }
      } catch (error) {
        // a failed summary is not retried for this absence: the next turn still folds at the usual threshold
        if (!controller.signal.aborted) settled.set(candidate.threadId, candidate.askedAt);
        deps.log?.(`idle compaction ${candidate.threadId}: ${controller.signal.aborted ? "abandoned" : "failed"}, ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = null;
      }
    }
    if (settled.size > 2_000) for (const key of [...settled.keys()].slice(0, settled.size - 2_000)) settled.delete(key);
    return done;
  }

  const schedule = (ms: number) => {
    if (disposed) return;
    timer = after(ms, () => { void sweep().catch(() => {}).finally(() => schedule(deps.sweepMs ?? IDLE_SWEEP_EVERY_MS)); });
  };

  return {
    sweep,
    start(): void { if (!timer && !disposed) schedule(deps.sweepMs ?? IDLE_SWEEP_FIRST_MS); },
    /** A turn began here: a summary being written for it is dropped, and is looked at again after the person's next absence. */
    turnStarted(threadId: string): void {
      if (running?.threadId === threadId) running.controller.abort();
    },
    running(): string | null { return running?.threadId ?? null; },
    dispose(): void {
      disposed = true;
      timer?.cancel();
      running?.controller.abort();
    },
  };
}
