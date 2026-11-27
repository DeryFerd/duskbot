import { movesThreadToTop } from "../../shared/wire";
import type { AppState, Message } from "./store";

export function mergeTaskStamps<T extends { threadId: string; updatedAt?: number; lastThreadOrderAt?: number }>(previous: T[] | undefined, incoming: T[] | undefined): T[] | undefined {
  if (!incoming) return previous;
  const prior = new Map((previous ?? []).map((task) => [task.threadId, task]));
  return incoming.map((task) => {
    const local = prior.get(task.threadId);
    if (!local) return task;
    const updatedAt = local.updatedAt === undefined ? task.updatedAt : Math.max(local.updatedAt, task.updatedAt ?? 0);
    const lastThreadOrderAt = local.lastThreadOrderAt === undefined ? task.lastThreadOrderAt : Math.max(local.lastThreadOrderAt, task.lastThreadOrderAt ?? 0);
    return updatedAt === task.updatedAt && lastThreadOrderAt === task.lastThreadOrderAt
      ? task : { ...task, updatedAt, lastThreadOrderAt };
  });
}

export function bumpThreadUpdatedAt(state: AppState, threadId: string, at: number, forOrder = false, orderAt = at): AppState {
  if (!Number.isFinite(at)) return state;
  const advance = <T extends { threadId: string; updatedAt?: number; lastThreadOrderAt?: number }>(tasks: T[] | undefined) =>
    tasks?.some((task) => task.threadId === threadId)
      ? tasks.map((task) => task.threadId === threadId ? { ...task, updatedAt: Math.max(task.updatedAt ?? 0, at),
        ...(forOrder ? { lastThreadOrderAt: Math.max(task.lastThreadOrderAt ?? 0, orderAt) } : {}) } : task)
      : tasks;
  return {
    ...state,
    bots: state.bots.map((bot) => {
      const tasks = advance(bot.tasks);
      return tasks === bot.tasks ? bot : { ...bot, tasks };
    }),
    groups: state.groups.map((group) => {
      const tasks = advance(group.tasks);
      return tasks === group.tasks ? group : { ...group, tasks };
    }),
  };
}

export function rewindThreadUpdatedAt(state: AppState, threadId: string, messages: Pick<Message, "at" | "role" | "kind" | "peerAsk" | "turnId" | "turnTerminal" | "turnCompletedAt">[], createdAt: number, orderFloor = createdAt): AppState {
  const at = messages.reduce((max, message) => Math.max(max, message.at || 0), createdAt);
  const orderAt = messages.reduce((max, message) => movesThreadToTop(message) ? Math.max(max, message.turnCompletedAt ?? message.at ?? 0) : max, orderFloor);
  const apply = <T extends { threadId: string; updatedAt?: number; lastThreadOrderAt?: number }>(tasks: T[] | undefined) =>
    tasks?.map((task) => task.threadId === threadId ? { ...task, updatedAt: at, lastThreadOrderAt: orderAt } : task);
  return {
    ...state,
    bots: state.bots.map((bot) => bot.tasks?.some((task) => task.threadId === threadId) ? { ...bot, tasks: apply(bot.tasks) } : bot),
    groups: state.groups.map((group) => group.tasks?.some((task) => task.threadId === threadId) ? { ...group, tasks: apply(group.tasks) } : group),
  };
}

const PREVIEW_KEPT = 4;

/** A row's preview list with a message from another of its threads: added when new, swapped in place when patched. */
export function previewOtherThread(state: AppState, list: "bots" | "groups", ownerId: string, action: { type: string; message?: Message }): AppState {
  const message = action.message;
  if (!message || (action.type !== "messageAdded" && action.type !== "messagePatched")) return state;
  const add = action.type === "messageAdded";
  const next = <T extends { id: string; previewMessages?: Message[] }>(owners: T[]) => owners.map((owner) => {
    if (owner.id !== ownerId) return owner;
    const previews = owner.previewMessages;
    if (previews?.some((m) => m.id === message.id)) return { ...owner, previewMessages: previews.map((m) => m.id === message.id ? message : m) };
    return add ? { ...owner, previewMessages: [...(previews ?? []), message].sort((a, b) => a.at - b.at).slice(-PREVIEW_KEPT) } : owner;
  });
  return list === "bots" ? { ...state, bots: next(state.bots) } : { ...state, groups: next(state.groups) };
}
