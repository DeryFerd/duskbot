import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { SquarePen } from "../icons";

import { cn } from "@/lib/cn";
import { botConversations, setMainConversation } from "@/lib/bot-conversations";
import { t } from "@/lib/i18n";
import { openBotThread } from "@/state/thread-navigation";
import { useStore, type Bot } from "@/state/store";
import { ConversationRows } from "./ConversationRows";
import { MENU_ITEM_SEPARATOR, MENU_LABEL, MENU_SHEET } from "./menu-recipe";
import { useMenuMotion } from "./MenuMotion";

/** The small menu under a header crumb: the bot's conversations, main first, and New conversation at the bottom. `anchor`
 * holds the crumb and the menu, so a press outside it closes the menu and one on the crumb does not reopen it. */
export function ConversationSwitcher({ bot, open, onClose, anchor }: {
  bot: Bot;
  open: boolean;
  onClose: (restoreFocus: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
}) {
  const { dispatch } = useStore();
  const motion = useMenuMotion(open);
  const menuRef = useRef<HTMLDivElement>(null);
  const canEdit = bot.yourAccess !== "view";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) onClose(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    menuRef.current?.querySelector<HTMLElement>("[aria-current=true]")?.focus({ preventScroll: true });
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, anchor, onClose]);

  if (!motion.shown) return null;
  const conversations = botConversations(bot);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]!.focus();
  };

  const openConversation = (threadId: string) => {
    if (threadId !== bot.threadId) openBotThread(dispatch, bot, threadId);
    onClose(false);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 top-full z-40 mt-1.5 flex justify-center">
      <div
        ref={menuRef}
        role="menu"
        data-conversation-switcher=""
        aria-label={t("botPanel.conversations.title")}
        onKeyDown={onKeyDown}
        className={cn("pointer-events-auto max-h-[min(380px,70dvh)] w-[300px] max-w-[calc(100vw-24px)] shrink-0 overflow-y-auto overscroll-contain", MENU_SHEET, motion.className)}
        {...motion.exitProps}
      >
        <div className={MENU_LABEL}>{t("botPanel.conversations.title")}</div>
        <ConversationRows
          kind="menu"
          conversations={conversations}
          onOpen={openConversation}
          onSetMain={canEdit ? (threadId) => setMainConversation(dispatch, bot.id, threadId) : undefined}
        />
        {canEdit && (
          <>
            <div role="separator" className={MENU_ITEM_SEPARATOR} />
            <button
              type="button"
              role="menuitem"
              data-conversation-new=""
              onClick={() => {
                dispatch({ type: "newTask", botId: bot.id });
                onClose(false);
              }}
              className="flex min-h-[34px] w-full items-center gap-2 rounded-[10px] px-2 py-1 text-left text-[13px] leading-[18px] text-ink hover:bg-ink/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus touch:min-h-11"
            >
              <SquarePen size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
              <span className="truncate">{t("botPanel.conversations.new")}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
