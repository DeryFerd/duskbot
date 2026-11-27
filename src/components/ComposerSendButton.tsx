import { useEffect, useRef, type CSSProperties } from "react";
import { ArrowUp, ChevronUp, Clock, CornerDownRight, RotateCcw } from "../icons";

import type { FollowUp, FollowUpDefault } from "../../shared/follow-up";
import type { SendKey } from "@/lib/send-key";
import { followUpHintWords } from "./composer-simple";
import { cn } from "@/lib/cn";
import { Icon } from "./Icon";
import { t } from "@/lib/i18n";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

const FOLLOW_UP_ICON = { steer: CornerDownRight, queue: Clock, restart: RotateCcw } as const;

export interface FollowUpMenu {
  /** What Enter does first, then the other one where the turn can be steered, then restart. */
  choices: FollowUp[];
  name: string;
  sendKey: string;
  alternateKey: string;
}

/** How long a press on Send lasts before it does the other follow-up, as a Ctrl/⌘-click does. */
export const HOLD_ALTERNATE_MS = 450;

/** The composer's round Send button. While a one-to-one bot works, a click does what Enter does and a Ctrl/⌘-click the
 * other one (a press held on a touch screen, which has no Ctrl/⌘ to hold, does the same); the chevron beside it lists
 * every way this message can meet the running turn. */
export function ComposerSendButton({ compact, waits, label, title, look, disabled, onSend, menu, onChoose, holdAlternate = false }: {
  compact: boolean;
  /** The message will wait for the running turn: a clock on a quiet button instead of the bot's colour. */
  waits: boolean;
  label: string;
  title: string;
  look: { className: string; style?: CSSProperties };
  disabled: boolean;
  onSend: (alternate: boolean) => void;
  menu?: FollowUpMenu;
  onChoose: (followUp: FollowUp) => void;
  /** A held touch press sends with the other follow-up. */
  holdAlternate?: boolean;
}) {
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  const endHold = () => { if (hold.current) window.clearTimeout(hold.current.timer); };
  useEffect(() => endHold, []);
  const alternate = menu?.choices[1] !== "restart" ? menu?.choices[1] : undefined;
  const button = (
    <button
      onClick={(event) => {
        if (hold.current?.fired) { hold.current = null; return; }
        onSend(event.metaKey || event.ctrlKey);
      }}
      onPointerDown={holdAlternate ? (event) => {
        endHold();
        hold.current = null;
        if (event.pointerType === "mouse" || disabled) return;
        const press = { timer: 0, fired: false };
        press.timer = window.setTimeout(() => { press.fired = true; onSend(true); }, HOLD_ALTERNATE_MS);
        hold.current = press;
      } : undefined}
      onPointerUp={holdAlternate ? endHold : undefined}
      onPointerCancel={holdAlternate ? () => { endHold(); hold.current = null; } : undefined}
      onContextMenu={holdAlternate ? (event) => event.preventDefault() : undefined}
      disabled={disabled}
      aria-label={label}
      data-composer-send={waits ? "waits" : ""}
      title={menu && alternate ? t("composer.followUp.buttonTitle", { title, key: menu.alternateKey, alternate: t(`composer.followUp.${alternate}`) }) : title}
      style={waits ? undefined : look.style}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full disabled:cursor-default",
        compact ? "composer-press size-7" : "size-8",
        waits ? "bg-raised text-ink-secondary hover:bg-raised-hover" : look.className,
      )}
    >
      {waits
        ? <Clock size={compact ? 14 : 15} className={compact ? "composer-glyph" : undefined} />
        : compact ? <Icon name="arrow-up" variant="filled" size={16} className="composer-glyph" /> : <ArrowUp size={16} strokeWidth={1.75} absoluteStrokeWidth />}
    </button>
  );
  if (!menu) return button;
  const items = menu.choices.map((choice, index): SidebarMenuItem => {
    const Icon = FOLLOW_UP_ICON[choice];
    return {
      key: choice,
      label: t(`composer.followUp.${choice}`),
      subtitle: t(`composer.followUp.${choice}Hint`, { name: menu.name }),
      icon: <Icon size={16} aria-hidden="true" />,
      active: index === 0,
      value: index === 0 ? menu.sendKey : choice === alternate ? menu.alternateKey : undefined,
      disabled,
      onSelect: () => onChoose(choice),
    };
  });
  return (
    <div data-composer-follow-up className="flex shrink-0 items-center">
      <SidebarPopoverMenu
        items={items}
        ariaLabel={t("composer.followUp.menu")}
        triggerTitle={t("composer.followUp.menu")}
        triggerClassName={cn(
          "flex shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink",
          compact ? "h-7 w-5" : "h-8 w-6",
        )}
        renderTrigger={() => <ChevronUp size={14} aria-hidden="true" />}
      />
      {button}
    </div>
  );
}

/** "↵ Queue · ⌘↵ Steer" beside Send while a one-to-one bot works; the field names it by `id` for screen readers. */
export function FollowUpKeyHint({ id, enter, sendKey }: { id: string; enter: FollowUpDefault; sendKey: SendKey }) {
  const hint = followUpHintWords(enter, sendKey);
  return (
    <span data-composer-follow-up-hint="" className="pointer-events-none me-0.5 shrink-0 whitespace-nowrap text-[12px] leading-4 text-ink/40 @max-[26rem]/composer:hidden">
      <span aria-hidden="true">{hint.text}</span>
      <span id={id} className="sr-only">{hint.aria}</span>
    </span>
  );
}
