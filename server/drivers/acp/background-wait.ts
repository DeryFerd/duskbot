// Antigravity CLI 1.5 answers a prompt with end_turn while a timer (`schedule`) or a command it backgrounded still runs.
// When that work ends it wakes itself, and the wake's tool calls and reply arrive as session/update with no prompt open.
import type { TurnProgressFields } from "../../../shared/turn-progress.ts";
import { trail } from "../../trail.ts";

/** What a call is to a turn that ended while it ran: work whose end wakes the agent, work that never ends on its own
 * (a dev server, a recurring timer, a timer past the longest wait), or neither. A timer knows when it fires. */
export type BackgroundCall = { kind: "wakes"; firesInMs?: number } | { kind: "endless" } | { kind: "other" };

/** The longest a turn waits on background work after its prompt answered; a longer timer is not waited on. */
export const backgroundWaitCapMs = (): number => {
  const set = Number(process.env.DUSK_ACP_BACKGROUND_WAIT_MS);
  return Number.isFinite(set) && set > 0 ? set : 15 * 60_000;
};
/** The agent sends usage_update after each model call; one with nothing running and nothing following ends the wake. */
export const WAKE_SETTLE_MS = 1_500;
/** Without that report, a wake still ends after this much silence with nothing running; so does a timer's wait once it
 * is this far past firing with nothing heard, as an agent that holds the wake back until the next prompt sends nothing. */
export const WAKE_QUIET_MS = 120_000;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function backgroundCall(update: { name?: unknown; title?: unknown; kind?: unknown; rawInput?: unknown; args?: unknown }): BackgroundCall {
  const input = record(update.rawInput) ?? record(update.args) ?? {};
  if (input.IsDaemon === true) return { kind: "endless" };
  const name = typeof update.name === "string" ? update.name : typeof update.title === "string" ? update.title.replace(/^Run /u, "") : "";
  if (name === "schedule") {
    const seconds = input.DurationSeconds;
    return typeof seconds === "number" && seconds > 0 && seconds * 1000 <= backgroundWaitCapMs()
      ? { kind: "wakes", firesInMs: seconds * 1000 }
      : { kind: "endless" };
  }
  if (update.kind === "execute" || /subagent/u.test(name)) return { kind: "wakes" };
  return { kind: "other" };
}

/** How long to wait on `calls` at most: past the last timer's firing when only timers run, else the cap. */
export function backgroundWaitMs(calls: readonly BackgroundCall[]): number {
  const cap = backgroundWaitCapMs();
  const timers = calls.map((call) => (call.kind === "wakes" ? call.firesInMs : undefined));
  return timers.every((ms) => ms !== undefined) ? Math.min(cap, Math.max(...timers) + WAKE_QUIET_MS) : cap;
}

interface WaitingTurn {
  runningTools: Set<string>;
  asks: { size: number };
  backgroundCalls: Map<string, BackgroundCall>;
  backgroundProgress: Map<string, TurnProgressFields>;
  backgroundWait: { observe: (kind: unknown) => void; stop: () => void } | null;
  stopQuietWatch: (() => void) | null;
  flushAssistantText: () => void;
}

/** Notes what a running call is to the wait, and lets a wait already open see the update. */
export function observeBackground(turn: WaitingTurn, update: any, progress: TurnProgressFields | null): void {
  const id = typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : null;
  if (id && (update.sessionUpdate === "tool_call" || (update.sessionUpdate === "tool_call_update" && !turn.backgroundCalls.has(id)))) {
    turn.backgroundCalls.set(id, backgroundCall(update));
  }
  if (id && progress) turn.backgroundProgress.set(id, progress);
  turn.backgroundWait?.observe(update.sessionUpdate);
}

/** Called when the prompt answered end_turn: opens the wait and returns true while work that wakes the agent still runs.
 * `say` puts the awaited call's progress back on the status line, the reply having just taken it; `end` settles the turn. */
export function waitForWake(turn: WaitingTurn, say: (progress: TurnProgressFields) => void, end: () => void): boolean {
  if (turn.asks.size) return false;
  const running = [...turn.runningTools];
  const waking = running.filter((id) => turn.backgroundCalls.get(id)?.kind === "wakes");
  if (!waking.length) return false;
  // calls still marked running that do not wake the agent say nothing about the wake
  const before = new Set(running.filter((id) => !waking.includes(id)));
  const busy = () => turn.asks.size > 0
    || [...turn.runningTools].some((id) => !before.has(id) && turn.backgroundCalls.get(id)?.kind !== "endless");
  turn.flushAssistantText();
  turn.stopQuietWatch?.();
  turn.stopQuietWatch = null;
  const startedAt = Date.now();
  const finish = (why: string) => {
    trail("acp.background_wait.ended", { why, ms: Date.now() - startedAt });
    end();
  };
  const deadline = setTimeout(() => finish("deadline"), backgroundWaitMs(waking.flatMap((id) => turn.backgroundCalls.get(id) ?? [])));
  deadline.unref?.();
  let quiet: ReturnType<typeof setTimeout> | null = null;
  turn.backgroundWait = {
    observe: (kind) => {
      if (quiet) clearTimeout(quiet);
      quiet = null;
      if (busy()) return;
      const woke = kind === "usage_update";
      (quiet = setTimeout(() => finish(woke ? "woke" : "quiet"), woke ? WAKE_SETTLE_MS : WAKE_QUIET_MS)).unref?.();
    },
    stop: () => {
      clearTimeout(deadline);
      if (quiet) clearTimeout(quiet);
    },
  };
  const progress = waking.map((id) => turn.backgroundProgress.get(id)).find(Boolean);
  if (progress) say(progress);
  trail("acp.background_wait.started", { calls: waking.length });
  return true;
}
