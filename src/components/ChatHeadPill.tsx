import { localizedTaskTitle } from "@/lib/task-title";
import { Lock, UserRound, Users } from "../icons";
import { useCallback, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { awayFromMainThread } from "@/state/thread-navigation";
import { BotAvatar } from "./Avatar";
import { Icon } from "./Icon";
import { BOT_PANEL_ID } from "./bot-panel/side-panel";
import { sharedChatAudience } from "./TeamPrivateChatsLine";
import { botConversations, conversationLabel } from "@/lib/bot-conversations";
import { ConversationSwitcher } from "./ConversationSwitcher";

/** The factory title a new conversation starts with. */
const UNTITLED = "New thread";

export type ChatHeadPrivacy = { kind: "private" } | { kind: "ownHelper" } | { kind: "shared"; team: string; onlyPeopleAdded?: boolean } | null;

const PRIVACY_ICONS = { private: Lock, ownHelper: UserRound, shared: Users } as const;

function privacyLabelOf(privacy: ChatHeadPrivacy): string | null {
  switch (privacy?.kind) {
    case "private": return t("team.privateHeader");
    case "ownHelper": return t("team.ownHelperHeader");
    case "shared": return sharedChatAudience(privacy.team, privacy.onlyPeopleAdded);
    default: return null;
  }
}

// grok's pill: a half-pixel ink/8 edge; under the pointer or keyboard a 3.5% ink tint, at once
const CHAT_HEAD_PILL = "chat-head-pill group relative isolate flex min-w-0 max-w-full items-center gap-2 rounded-full border-[0.5px] border-transparent bg-composer py-[7.5px] pl-[7.5px] pr-[13.5px] text-ink shadow-(--shadow-float) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-ink/[0.035] before:opacity-0 before:content-[''] hover:before:opacity-100 focus-visible:before:opacity-100";


/** A room in the pill: its members' faces where a bot's face goes, its name, and whether its panel is open. */
export interface ChatHeadRoom {
  name: string;
  faces: ReactNode;
  label: string;
  expanded: boolean;
}

/** A bot's chat passes `bot`, `avatar` and `privacy`; a room passes `room` alone. */
interface ChatHeadPillProps {
  bot?: Bot;
  avatar?: Pick<ComponentProps<typeof BotAvatar>, "state" | "motion" | "motionKey" | "animated">;
  privacy?: ChatHeadPrivacy;
  room?: ChatHeadRoom;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** Simple mode's whole chat header: the bot's face and name in one pill, which opens and closes the bot panel. Away from
 * the bot's main conversation it also names the one on screen; a team chat says who can read it with one quiet glyph.
 * No dot: the sidebar says which of the bot's other conversations need a look. A room's header is the same pill with
 * its members' faces. */
export function ChatHeadPill({ bot, avatar, privacy = null, room, onToggle }: ChatHeadPillProps) {
  const { state } = useStore();
  const open = room ? room.expanded : state.settingsOpen;
  const privacyLabel = privacyLabelOf(privacy);
  const PrivacyIcon = privacy ? PRIVACY_ICONS[privacy.kind] : Users;
  const shown = bot?.tasks?.find((task) => task.threadId === bot.threadId);
  const title = shown?.title;
  // Simple mode calls an untitled conversation what it is, never a "thread"; a teammate's work is never named as one.
  const conversation = !bot ? null : !awayFromMainThread(bot) || shown?.openedBy?.kind === "work" ? (privacy?.kind === "shared" ? t("task.sharedChat") : null)
    : !title || title === UNTITLED ? t("task.untitledConversation") : localizedTaskTitle(title);
  const label = room ? room.label : t("chat.openProfileAria", { name: bot?.name ?? "" });
  const conversations = bot ? botConversations(bot) : [];
  // a bot with a second conversation always says which one this is, the main chat included, and the crumb switches
  const switcher = bot && !room && conversations.length > 1;
  if (switcher) {
    const current = conversations.find((entry) => entry.current);
    const crumb = conversation ?? (privacy?.kind === "shared" ? t("task.sharedChat") : conversationLabel(current ?? { main: true, title: "" }));
    return <ChatHeadSwitcherPill bot={bot} avatar={avatar} privacy={privacy} privacyLabel={privacyLabel} open={open} label={conversation ? `${label}, ${crumb}` : label} crumb={crumb} onToggle={onToggle} />;
  }
  return (
    <button
      type="button"
      data-chathead-pill
      data-tour={bot ? "bot-pill" : undefined}
      onClick={onToggle}
      aria-label={conversation ? `${label}, ${conversation}` : label}
      aria-expanded={open}
      aria-controls={open && bot ? BOT_PANEL_ID : undefined}
      className={CHAT_HEAD_PILL}
    >
      {room ? room.faces : bot && <BotAvatar bot={bot} size={24} {...avatar} />}
      <span dir="auto" className="min-w-0 truncate text-[14px] font-medium leading-5">{room ? room.name : bot?.name}</span>
      {conversation && (
        <>
          <Icon name="chevron-right" size={12} className="shrink-0 text-ink/[0.56]" />
          <span data-chathead-conversation dir="auto" className="min-w-0 max-w-[180px] truncate text-[14px] font-medium leading-5 text-ink-secondary">{conversation}</span>
        </>
      )}
      {privacyLabel && (
        <span data-chathead-privacy={privacy?.kind} title={privacyLabel} className="flex shrink-0 text-ink-tertiary">
          <PrivacyIcon size={13} aria-hidden="true" />
          <span className="sr-only">{privacyLabel}</span>
        </span>
      )}
    </button>
  );
}

const GROUP = "chat-head-group relative flex min-w-0 max-w-full items-center rounded-full border-[0.5px] border-transparent bg-composer text-ink shadow-(--shadow-float)";
const HALF = "chat-head-pill group relative isolate flex min-w-0 items-center gap-2 rounded-full py-[7.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** The pill of a bot with more than one conversation: the face and name still open the bot panel; the crumb beside them
 * names this conversation and opens the switcher. */
function ChatHeadSwitcherPill({ bot, avatar, privacy, privacyLabel, open, label, crumb, onToggle }: {
  bot: Bot;
  avatar: ChatHeadPillProps["avatar"];
  privacy: ChatHeadPrivacy;
  privacyLabel: string | null;
  open: boolean;
  label: string;
  crumb: string;
  onToggle: ChatHeadPillProps["onToggle"];
}) {
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const crumbButton = useRef<HTMLButtonElement>(null);
  const PrivacyIcon = privacy ? PRIVACY_ICONS[privacy.kind] : Users;
  const close = useCallback((restoreFocus: boolean) => {
    setMenu(false);
    if (restoreFocus) crumbButton.current?.focus();
  }, []);
  return (
    <div ref={anchor} className="relative flex min-w-0 max-w-full justify-center">
      <div className={GROUP} data-chathead-group="">
        <button
          type="button"
          data-chathead-pill
          data-tour="bot-pill"
          onClick={onToggle}
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? BOT_PANEL_ID : undefined}
          className={cn(HALF, "shrink-0 pl-[7.5px] pr-2")}
        >
          <BotAvatar bot={bot} size={24} {...avatar} />
          <span dir="auto" className="min-w-0 max-w-[160px] truncate text-[14px] font-medium leading-5">{bot.name}</span>
        </button>
        <Icon name="chevron-right" size={12} className="pointer-events-none shrink-0 text-ink/[0.56]" />
        <button
          ref={crumbButton}
          type="button"
          data-chathead-crumb
          onClick={() => setMenu((value) => !value)}
          aria-label={t("chat.conversations.switch", { name: crumb })}
          aria-haspopup="menu"
          aria-expanded={menu}
          className={cn(HALF, "min-w-0 pl-2 pr-[13.5px] tracking-[0.01em]")}
        >
          <span data-chathead-conversation dir="auto" className="min-w-0 max-w-[180px] truncate text-[14px] font-medium leading-5 text-ink-secondary">{crumb}</span>
          {privacyLabel && (
            <span data-chathead-privacy={privacy?.kind} title={privacyLabel} className="flex shrink-0 text-ink-tertiary">
              <PrivacyIcon size={13} aria-hidden="true" />
              <span className="sr-only">{privacyLabel}</span>
            </span>
          )}
        </button>
      </div>
      <ConversationSwitcher bot={bot} open={menu} onClose={close} anchor={anchor} />
    </div>
  );
}
