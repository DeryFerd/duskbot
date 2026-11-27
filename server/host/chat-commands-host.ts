// What /new, /compact and hours-away compaction need from the server (shared/chat-commands.ts, server/idle-compaction.ts):
// - leftForNewChat / startNewChat: a fresh chat for the bot; the one it left captures its memory now;
// - chatAppCompact: /compact from Telegram or Discord, as Compact now;
// - createAwayCompaction: the sweep, given which conversations qualify and how one is folded.
import { randomUUID } from "node:crypto";
import type { BotRecord, Message, Store } from "../store.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import { conversationHold, type QuietDeps } from "./warm-summary-host.ts";
import { createIdleCompaction, IDLE_COMPACT_MIN_TOKENS, idleCompactHours } from "../idle-compaction.ts";

type ChatStore = Pick<Store, "taskByThread" | "groupByThread" | "activePath" | "createTask">;

export function createNewChat(deps: {
  /** A getter: the server builds this before its store exists. */
  store(): ChatStore;
  /** Captures the thread's waiting memory now (memoryUpkeep.flushThread). */
  flushMemory(threadId: string): void;
}) {
  const said = (threadId: string) => deps.store().activePath(threadId).some((m) => m.role === "user");
  /** `/new` (or New chat with the chat it left): what the old chat taught is captured now rather than after its quiet
   * minutes. It stays saved as it was, and session_search still finds it. */
  function leftForNewChat(botId: string, fromThreadId: string, newThreadId: string): void {
    const store = deps.store();
    if (fromThreadId === newThreadId || !store.taskByThread(botId, fromThreadId) || store.groupByThread(fromThreadId)) return;
    deps.flushMemory(fromThreadId);
  }
  /** `/new` sent as a message (the API, an older app): a fresh conversation for the bot, selected. A chat with nothing
   * said in it yet is already fresh and is kept. `starter`: who opened it, as for New chat on a shared workspace. */
  function startNewChat(botId: string, fromThreadId: string, starter?: string, setStarter?: (threadId: string, key: string) => void): { threadId: string; fresh: boolean } | null {
    if (!said(fromThreadId)) return { threadId: fromThreadId, fresh: false };
    const task = deps.store().createTask(botId, undefined, true);
    if (!task) return null;
    if (starter) setStarter?.(task.threadId, starter);
    leftForNewChat(botId, fromThreadId, task.threadId);
    return { threadId: task.threadId, fresh: true };
  }
  return { leftForNewChat, startNewChat };
}

/** /compact from a chat app: "busy" while a reply is under way, as the app's Compact now is. */
export function chatAppCompact(deps: {
  threadBusy(botId: string, threadId: string): boolean;
  startCompact(botId: string, threadId: string, focus: string, trigger: UsageTrigger): Promise<unknown>;
  trigger: UsageTrigger;
  log(line: string): void;
}) {
  return async (botId: string, threadId: string, focus: string): Promise<"started" | "busy" | "failed"> => {
    if (deps.threadBusy(botId, threadId)) return "busy";
    try {
      await deps.startCompact(botId, threadId, focus, deps.trigger);
      return "started";
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (status !== 409) deps.log(`chat app /compact failed: ${error instanceof Error ? error.message : String(error)}`);
      return status === 409 ? "busy" : "failed";
    }
  };
}

type Instance = { instanceId: string };
type CompactionRecord = { id: string; at: number } | undefined;

/** Hours away, wired to the server. DUSK_IDLE_SWEEP_MS and DUSK_IDLE_COMPACT_MIN_TOKENS are a test fixture's: a sweep in
 * seconds, a floor a fake engine reaches. */
export function createAwayCompaction<I extends Instance>(deps: {
  store: Pick<Store, "bots" | "taskByThread" | "groupByThread" | "activePath" | "projectBotForTask">;
  settings(): { autoCompact?: boolean; idleCompactHours?: number } | undefined;
  quiet: QuietDeps;
  warm: { state(threadId: string): { running: boolean; last?: { at: number; outcome: string } } | undefined };
  latestCompaction(messages: readonly Message[]): CompactionRecord;
  botForThread(botId: string, threadId: string): BotRecord | null;
  instance(instanceId: string): I | undefined;
  fold(input: { bot: BotRecord; threadId: string; generation: string; instance: I; model: string; signal: AbortSignal; away: { hours: number; minTokens: number } }): Promise<void>;
  env?: NodeJS.ProcessEnv;
  log?(line: string): void;
}) {
  const env = deps.env ?? process.env;
  const hours = () => deps.settings()?.autoCompact === false ? 0 : idleCompactHours(deps.settings()?.idleCompactHours, env.DUSK_IDLE_COMPACT_HOURS);
  const minTokens = Number(env.DUSK_IDLE_COMPACT_MIN_TOKENS) > 0 ? Number(env.DUSK_IDLE_COMPACT_MIN_TOKENS) : IDLE_COMPACT_MIN_TOKENS;
  const latest = (threadId: string) => deps.latestCompaction(deps.store.activePath(threadId));
  return createIdleCompaction({
    now: () => Date.now(), log: deps.log ?? ((line) => console.info(line)), hours,
    ...(Number(env.DUSK_IDLE_SWEEP_MS) > 0 ? { sweepMs: Number(env.DUSK_IDLE_SWEEP_MS) } : {}),
    candidates: (askedBefore) => deps.store.bots.flatMap((bot) => (bot.tasks ?? []).flatMap((task) => {
      if (task.askedAt === undefined || task.askedAt > askedBefore || task.routineRunId || task.archivedAt !== undefined || task.openedBy !== undefined) return [];
      if (deps.store.groupByThread(task.threadId)) return [];
      const warm = deps.warm.state(task.threadId)?.last;
      const compactedAt = Math.max(latest(task.threadId)?.at ?? -1, warm?.outcome === "summarized" ? warm.at : -1);
      return [{ botId: bot.id, threadId: task.threadId, askedAt: task.askedAt, ...(compactedAt >= 0 ? { compactedAt } : {}) }];
    })),
    hold: (target) => deps.warm.state(target.threadId)?.running ? "the warm summary is running" : conversationHold(deps.quiet, target, Date.now())?.reason ?? null,
    compact: async ({ botId, threadId }, signal) => {
      const bot = deps.store.projectBotForTask(botId, threadId), task = deps.store.taskByThread(botId, threadId);
      if (!bot || !task) return false;
      // the engine and model of the last measured turn; an engine that reports no context size: the conversation's own
      const measured = task.lastInstanceId && task.lastContextModel?.startsWith(`${task.lastInstanceId}:`) ? task.lastInstanceId : undefined;
      const selection = (deps.botForThread(botId, threadId) ?? bot).modelSelection;
      const instanceId = measured ?? selection.instanceId, model = measured ? task.lastContextModel!.slice(measured.length + 1) : selection.model;
      const instance = deps.instance(instanceId);
      if (!instance || !model) return false;
      const before = latest(threadId)?.id;
      await deps.fold({ bot, threadId, generation: `away:${randomUUID()}`, instance, model, signal, away: { hours: hours(), minTokens } });
      return latest(threadId)?.id !== before;
    },
  });
}
