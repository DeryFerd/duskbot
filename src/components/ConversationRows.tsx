import { Star } from "../icons";

import { cn } from "@/lib/cn";
import { conversationLabel, type BotConversation } from "@/lib/bot-conversations";
import { t } from "@/lib/i18n";
import { stampClock, threadUpdatedLabel, useRelativeNow } from "./SidebarThreadRow";

interface ConversationRowsProps {
  conversations: readonly BotConversation[];
  /** "menu" rows are the switcher's menu items; "list" rows sit in the bot panel. */
  kind: "menu" | "list";
  onOpen(threadId: string): void;
  /** Absent for a person who can only read the bot. */
  onSetMain?: (threadId: string) => void;
}

/** One conversation per row, its title and how long ago it moved, the same in the header switcher and the bot panel. The
 * main chat wears a filled star; any other row offers that star to make it main. */
export function ConversationRows({ conversations, kind, onOpen, onSetMain }: ConversationRowsProps) {
  const now = useRelativeNow();
  const menu = kind === "menu";
  return (
    <>
      {conversations.map((conversation) => {
        const label = conversationLabel(conversation);
        const stamped = stampClock(conversation.at, now);
        const ago = conversation.at > 0 ? threadUpdatedLabel(conversation.at, stamped ?? now) : "";
        return (
          <div
            key={conversation.threadId}
            role={menu ? "none" : "listitem"}
            data-conversation={conversation.threadId}
            data-conversation-main={conversation.main ? "" : undefined}
            className={cn("group/conversation relative flex min-h-[34px] items-center rounded-[10px] hover:bg-ink/[0.06] has-[:focus-visible]:bg-ink/[0.06]", conversation.current && "bg-ink/[0.05]")}
          >
            <button
              type="button"
              role={menu ? "menuitem" : undefined}
              aria-current={conversation.current ? "true" : undefined}
              data-conversation-open=""
              onClick={() => onOpen(conversation.threadId)}
              className={cn(
                "flex min-h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[10px] py-1 pl-2 pr-1 text-left text-[13px] leading-[18px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus touch:min-h-11",
                conversation.current && "font-medium",
              )}
            >
              <span dir="auto" className="min-w-0 flex-1 truncate">{label}</span>
              {conversation.unread && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />}
              {conversation.unread && <span className="sr-only">{t("sidebar.unread")}</span>}
              {ago && <time className="shrink-0 text-[12px] font-normal leading-4 text-ink-tertiary">{ago}</time>}
            </button>
            {conversation.main ? (
              <span className="flex size-7 shrink-0 items-center justify-center text-ink-secondary" title={t("chat.conversations.main")}>
                <Star size={13} fill="currentColor" aria-hidden="true" />
              </span>
            ) : onSetMain ? (
              <button
                type="button"
                data-conversation-set-main=""
                aria-label={t("sidebar.bot.simple.setMainThread")}
                title={t("sidebar.bot.simple.setMainThread")}
                onClick={() => onSetMain(conversation.threadId)}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary opacity-0 transition-opacity duration-100 hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus group-hover/conversation:opacity-100 touch:size-11 touch:opacity-100"
              >
                <Star size={13} aria-hidden="true" />
              </button>
            ) : <span className="size-7 shrink-0" aria-hidden="true" />}
          </div>
        );
      })}
    </>
  );
}
