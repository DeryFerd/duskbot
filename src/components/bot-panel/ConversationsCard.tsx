import { useState } from "react";

import { botConversations, setMainConversation } from "@/lib/bot-conversations";
import { t } from "@/lib/i18n";
import { usePhoneLayout } from "@/lib/use-media-query";
import { useStore, type Bot } from "@/state/store";
import { openBotThread } from "@/state/thread-navigation";
import { ConversationRows } from "../ConversationRows";
import { Card, LabelAction } from "./rows";

const SHOWN = 5;

/** The bot's conversations in its panel, once it has more than one: the same rows as the header switcher. A bot with one
 * conversation shows nothing here. */
export function ConversationsCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const phone = usePhoneLayout();
  const [expanded, setExpanded] = useState(false);
  const conversations = botConversations(bot);
  if (conversations.length < 2) return null;
  const hidden = Math.max(0, conversations.length - SHOWN);
  const listed = expanded || !hidden ? conversations : conversations.filter((entry, index) => index < SHOWN || entry.current);
  const more = conversations.length - listed.length;
  return (
    <Card
      label={t("botPanel.conversations.title")}
      anchor="conversations-list"
      action={hidden > 0 ? (
        <LabelAction data-panel-action="conversations-more" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t("botPanel.conversations.showFewer") : t("botPanel.conversations.showMore", { count: more || hidden })}
        </LabelAction>
      ) : undefined}
    >
      <div role="list" aria-label={t("botPanel.conversations.title")} className="flex flex-col gap-0.5">
        <ConversationRows
          kind="list"
          conversations={listed}
          onOpen={(threadId) => {
            if (threadId !== bot.threadId) openBotThread(dispatch, bot, threadId);
            if (phone) dispatch({ type: "toggleSettings", open: false });
          }}
          onSetMain={bot.yourAccess === "view" ? undefined : (threadId) => setMainConversation(dispatch, bot.id, threadId)}
        />
      </div>
    </Card>
  );
}
