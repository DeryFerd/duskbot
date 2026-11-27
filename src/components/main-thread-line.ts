import { useEffect, useState } from "react";

import { lastLine } from "./sidebar-preview";
import { api, visibleMessages, type Bot, type InstanceInfo, type Message } from "@/state/store";
import { botOpensTo } from "@/state/thread-navigation";

const LINE_PAGE = 8;
const MAX_CACHED = 100;
const lines = new Map<string, string>();
const asked = new Set<string>();

type Page = { messages?: Message[]; activeLeafId?: string | null };

/** The bot row's line while an empty conversation is open beside the main one: what the main chat last said, so the row
 * never goes blank. Read once per change of the main chat, and only while it is wanted. */
export function useMainThreadLine(bot: Bot, wanted: boolean, instances: InstanceInfo[]): string {
  const mainId = botOpensTo(bot, false);
  const main = bot.tasks?.find((task) => task.threadId === mainId);
  const key = `${mainId}@${main?.updatedAt ?? main?.createdAt ?? 0}`;
  const [, settle] = useState(0);
  const enabled = wanted && mainId !== bot.threadId && Boolean(main);
  useEffect(() => {
    if (!enabled || lines.has(key) || asked.has(key)) return;
    asked.add(key);
    void api<Page>(`/api/threads/${encodeURIComponent(mainId)}/messages?limit=${LINE_PAGE}`, { background: true })
      .then((page) => {
        lines.set(key, lastLine({ ...bot, threadId: mainId }, visibleMessages({ messages: page.messages ?? [], activeLeafId: page.activeLeafId ?? undefined }), instances));
        if (lines.size > MAX_CACHED) lines.delete(lines.keys().next().value!);
        settle((count) => count + 1);
      })
      .catch(() => {})
      .finally(() => asked.delete(key));
  }, [enabled, key]);
  return enabled ? lines.get(key) ?? "" : "";
}
