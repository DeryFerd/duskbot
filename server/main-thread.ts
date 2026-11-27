interface MainThreadCandidate {
  threadId: string;
  createdAt: number;
  askedAt?: number;
  archivedAt?: number;
  routineRunId?: string;
  chatApp?: boolean;
  /** Set on a thread a bot opened (start_thread, a teammate's hand-off): a job beside the person's chat, not their chat. */
  openedBy?: unknown;
}

export function oldestThread(tasks: readonly MainThreadCandidate[]): string | undefined {
  const visible = tasks.filter((task) => !task.routineRunId);
  const open = visible.filter((task) => task.archivedAt === undefined);
  return (open.length ? open : visible).reduce<MainThreadCandidate | undefined>(
    (oldest, task) => (!oldest || task.createdAt < oldest.createdAt ? task : oldest), undefined,
  )?.threadId;
}

export function wasOldestThread(tasks: readonly MainThreadCandidate[], threadId: string): boolean {
  const saved = tasks.find((task) => task.threadId === threadId && !task.routineRunId);
  return saved !== undefined && !tasks.some((task) => !task.routineRunId && task.archivedAt === undefined && task.createdAt < saved.createdAt);
}

/** The thread a bot opens to when threads are hidden: the one the person chose (while it is open), else the open thread
 * they last wrote in, else the selected one, else the oldest. A chat app's thread (Telegram, Discord) and a job a bot
 * opened are the last one written in, or the selected one, only when the bot has no open thread of the person's own:
 * writing in a job to steer it never hides the chat the person started from. */
export function mainThread(tasks: readonly MainThreadCandidate[], selectedId?: string, chosenId?: string): string | undefined {
  const open = tasks.filter((task) => !task.routineRunId && task.archivedAt === undefined);
  if (chosenId && open.some((task) => task.threadId === chosenId)) return chosenId;
  const own = open.filter((task) => !task.chatApp && !task.openedBy);
  const notChatApp = open.filter((task) => !task.chatApp);
  const pool = own.length ? own : notChatApp.length ? notChatApp : open;
  const asked = pool.reduce<MainThreadCandidate | undefined>(
    (latest, task) => ((task.askedAt ?? -1) > (latest?.askedAt ?? -1) ? task : latest), undefined,
  );
  return asked?.threadId ?? pool.find((task) => task.threadId === selectedId)?.threadId ?? oldestThread(own.length ? own : tasks);
}
