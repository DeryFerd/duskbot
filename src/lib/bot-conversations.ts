import type { Dispatch } from "react";

import type { Action, Bot, Task } from "@/state/store";
import { botOpensTo } from "@/state/thread-navigation";
import { t } from "./i18n";
import { localizedTaskTitle } from "./task-title";

export interface BotConversation {
  threadId: string;
  title: string;
  at: number;
  main: boolean;
  current: boolean;
  unread: boolean;
  busy: boolean;
}

const isListed = (task: Task, bot: Pick<Bot, "threadId">) =>
  task.openedBy?.kind !== "work" && (task.threadId === bot.threadId || (!task.routineRunId && task.archivedAt === undefined));

const recency = (task: Pick<Task, "updatedAt" | "createdAt">) => task.updatedAt ?? task.createdAt ?? 0;

/** A bot's open conversations as its switcher lists them: the main one first, then the rest newest first. */
export function botConversations(bot: Pick<Bot, "threadId" | "mainThreadId" | "tasks">): BotConversation[] {
  const main = botOpensTo(bot, false);
  return (bot.tasks ?? [])
    .filter((task) => isListed(task, bot))
    .map((task) => ({
      threadId: task.threadId,
      title: task.title,
      at: recency(task),
      main: task.threadId === main,
      current: task.threadId === bot.threadId,
      unread: Boolean(task.unread) && task.threadId !== bot.threadId,
      busy: Boolean(task.busy),
    }))
    .sort((a, b) => Number(b.main) - Number(a.main) || b.at - a.at);
}

/** Only a bot with a second conversation grows a breadcrumb and a list; one conversation looks as it always has. */
export function hasSideConversations(bot: Pick<Bot, "threadId" | "mainThreadId" | "tasks">): boolean {
  return botConversations(bot).length > 1;
}

export function conversationLabel(conversation: Pick<BotConversation, "main" | "title">): string {
  if (conversation.main) return t("chat.conversations.main");
  return !conversation.title || conversation.title === "New thread" ? t("task.untitledConversation") : localizedTaskTitle(conversation.title);
}

export function setMainConversation(dispatch: Dispatch<Action>, botId: string, threadId: string): void {
  dispatch({ type: "updateBot", botId, patch: { mainThreadChoice: threadId } });
}
