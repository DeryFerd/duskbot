// Where an automation's runs report: the chat a routine chose, else the chat or room it was made in while that is open,
// else the bot's main chat. On a Cloud home a chat the owner writes in never gets words they did not choose, so it stays
// theirs: a routine someone else wrote, and every outside event, report into a chat of their own.
import { CLOUD_OUTSIDE_KEY } from "./cloud-sharing.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import { threadTitleFrom, type Message, type Store, type TaskRecord } from "./store.ts";

export interface AutomationDestinationDeps {
  store: Pick<Store, "bot" | "createTask" | "groupByThread" | "groupTaskByThread" | "messagesFor" | "roomThreadOf" | "taskByThread">;
  mainThread(botId: string): string | undefined;
  runs(): readonly Pick<RoutineRun, "webhookId" | "botId" | "resultsThreadId">[];
  /** A Team Cloud: a routine reports to the bot's shared chat, never into one person's chat a teammate could write it for. */
  team?: boolean;
  /** Only on a Cloud home. */
  cloud: {
    owner: string;
    /** Who a routine's chat counts as opened by. */
    opener(routineId: string): string;
    reportFromOthers(line: Message): boolean;
    /** No guest ever wrote in this chat. */
    ownersChat(threadId: string): boolean;
    opened(threadId: string, person: string): void;
    /** This chat holds what an outside event's run reported. */
    outside(threadId: string): void;
  } | null;
}

function legacyResultsThread(routineName: string, task: TaskRecord): boolean {
  return task.title.endsWith(" · Results") || task.title === threadTitleFrom(`${routineName} · Results`);
}

export function createAutomationDestinations(deps: AutomationDestinationDeps) {
  const { store, cloud } = deps;
  const chatOfItsOwn = (botId: string, name: string, person: string) => {
    const threadId = store.createTask(botId, `${name} · Results`, false)?.threadId;
    if (threadId) cloud?.opened(threadId, person);
    return threadId;
  };
  /** The room conversation `threadId` belongs to, while `botId` is still a member and it is not archived. */
  const openRoom = (botId: string, threadId: string): string | undefined => {
    const room = store.groupByThread(threadId);
    if (!room || room.dm || !room.memberIds.includes(botId)) return undefined;
    const roomThread = store.roomThreadOf(threadId);
    if (roomThread === room.threadId) return roomThread;
    const conversation = store.groupTaskByThread(room.id, roomThread);
    return conversation && conversation.archivedAt === undefined ? roomThread : undefined;
  };
  // the bot promises a routine made in a chat reports "here in this chat", so it does while that chat is open
  const sourceChat = (routine: Pick<Routine, "id" | "name" | "botId" | "sourceThreadId">): string | undefined => {
    const bot = store.bot(routine.botId);
    if (deps.team || !routine.sourceThreadId || !bot || bot.hidden) return undefined;
    if (cloud && (cloud.opener(routine.id) !== cloud.owner || !cloud.ownersChat(routine.sourceThreadId))) return undefined;
    const task = store.taskByThread(bot.id, routine.sourceThreadId);
    if (task) return !task.routineRunId && task.archivedAt === undefined && !legacyResultsThread(routine.name, task) ? task.threadId : undefined;
    return openRoom(bot.id, routine.sourceThreadId);
  };
  return {
    sourceChat,
    openRoom,
    /** The chat of its own an outside event's run reports into on a Cloud: never the person's, and never a wait's, which reports to the chat that set it. */
    eventChat(run: Pick<RoutineRun, "botId" | "routineName" | "resultsThreadId" | "eventSource">): string | undefined {
      const task = cloud && run.eventSource !== "wait" && run.resultsThreadId ? store.taskByThread(run.botId, run.resultsThreadId) : undefined;
      return task && legacyResultsThread(run.routineName, task) ? task.threadId : undefined;
    },
    routine(routine: Routine, forceNew: boolean): { threadId: string; main?: true } | undefined {
      const bot = store.bot(routine.botId);
      const opener = cloud?.opener(routine.id);
      // A routine outside work wrote reports nowhere a person already works, whatever chat it names.
      const chosen = !forceNew && opener !== CLOUD_OUTSIDE_KEY && routine.resultsThreadId && bot && !bot.hidden ? store.taskByThread(bot.id, routine.resultsThreadId) : undefined;
      const main = bot && !bot.hidden ? deps.mainThread(bot.id) : undefined;
      const mainAllowed = main && (!cloud || opener === cloud.owner);
      const archivedSource = chosen?.threadId === routine.sourceThreadId && chosen?.archivedAt !== undefined;
      if (chosen && !chosen.routineRunId && !archivedSource && !(mainAllowed && legacyResultsThread(routine.name, chosen))) return { threadId: chosen.threadId };
      const source = forceNew ? undefined : sourceChat(routine);
      if (source) return { threadId: source };
      if (mainAllowed) return { threadId: main, main: true };
      const threadId = cloud ? chatOfItsOwn(routine.botId, routine.name, opener!) : undefined;
      return threadId ? { threadId } : undefined;
    },
    event({ webhookId, webhookName, botId }: { webhookId: string; webhookName: string; botId: string }): string | undefined {
      const bot = store.bot(botId);
      if (!bot || bot.hidden) return undefined;
      if (!cloud) return deps.mainThread(botId);
      const earlier = deps.runs().find((run) => run.webhookId === webhookId && run.botId === botId && run.resultsThreadId)?.resultsThreadId;
      const kept = earlier ? store.taskByThread(botId, earlier) : undefined;
      const lines = kept && !kept.routineRunId ? store.messagesFor(kept.threadId) : undefined;
      const threadId = kept && lines && (lines.length === 0 || lines.some(cloud.reportFromOthers)) ? kept.threadId : chatOfItsOwn(botId, webhookName, cloud.owner);
      if (threadId) cloud.outside(threadId);
      return threadId;
    },
  };
}
