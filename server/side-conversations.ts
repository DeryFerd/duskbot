// A bot keeps one long main conversation; a conversation the person starts beside it (/new, New conversation) is a side
// one: writing in it never makes it main (main-thread.ts), and one left without a word written is archived, not kept.
import type { Store } from "./store.ts";

type SideStore = Pick<Store, "tasks" | "patchTask" | "activePath">;

/** Marks a conversation the person just started as a side one when they already have another open conversation here. */
export function markSideConversation(store: Pick<Store, "tasks" | "patchTask">, botId: string, threadId: string): boolean {
  const others = store.tasks(botId).some((task) => task.threadId !== threadId && !task.routineRunId && task.archivedAt === undefined && !task.openedBy);
  if (!others) return false;
  store.patchTask(botId, threadId, { side: true });
  return true;
}

/** Archives each side conversation of the bot that nothing was written in, other than the one still open. */
export function archiveEmptySideConversations(store: SideStore, botId: string, openThreadId: string, busy: (threadId: string) => boolean = () => false, now = Date.now()): string[] {
  const archived: string[] = [];
  for (const task of store.tasks(botId)) {
    if (task.side !== true || task.archivedAt !== undefined || task.pinned === true || task.threadId === openThreadId || busy(task.threadId)) continue;
    if (store.activePath(task.threadId).some((message) => message.role === "user")) continue;
    store.patchTask(botId, task.threadId, { archivedAt: now });
    archived.push(task.threadId);
  }
  return archived;
}
