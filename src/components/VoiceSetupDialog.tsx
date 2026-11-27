import { useEffect, useId, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, ChevronRight, Loader2, Phone, X } from "../icons";

import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import { openBot, useStore, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { VoiceSettings } from "./VoiceSettings";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";
import { openBotSettings } from "./bot-panel/panel-link";
import { cn } from "@/lib/cn";
import { formBodyCls, formCloseCls, formFooterCls, formHeaderCls, formSheetCls, formTitleCls, mdPrimaryCls, rowHintCls } from "./ui/GrokDialog";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const VOICE_PICKER = "[data-voice-picker]:not([disabled])";
const FIRST_FIELD = "input:not([disabled]), select:not([disabled])";

export function VoiceSetupDialog({
  bot,
  callName,
  ready,
  onClose,
  onStartCall,
  returnFocusRef,
}: {
  bot: Bot;
  callName: string;
  ready: boolean;
  onClose: () => void;
  onStartCall: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { state, dispatch } = useStore();
  const { patch } = useBotSettingsDerived(bot);
  const { capabilities } = useDesktopCapabilities();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const subtitleId = useId();
  const close = () => onCloseRef.current();

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (element) => element.getClientRects().length > 0,
      );
    (
      dialog?.querySelector<HTMLElement>(VOICE_PICKER) ??
      dialog?.querySelector<HTMLElement>(FIRST_FIELD) ??
      dialog
    )?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      if (document.activeElement === dialog || !dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      (returnFocusRef?.current ?? previousFocus)?.focus();
    };
  }, [returnFocusRef]);

  const openAllSettings = () => {
    close();
    if (state.selectedId !== bot.id) openBot(dispatch, bot);
    openBotSettings(dispatch, "voice");
  };

  return createPortal(
    <div
      className="glass-popup-frame"
      style={glassPopupFrameStyle()}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="ui-dialog-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
        data-voice-setup-dialog={bot.id}
        className={cn(formSheetCls, "max-h-full w-[min(480px,100%)] focus-visible:outline-none!")}
      >
        <header className={formHeaderCls}>
          <h2 id={titleId} className={formTitleCls}>
            {t("call.voiceSetup.title", { name: bot.name })}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={t("call.voiceSetup.close")}
            className={formCloseCls}
          >
            <X size={16} />
          </button>
        </header>

        <div className={formBodyCls}>
          <p id={subtitleId} className={cn(rowHintCls, "m-0 mb-3 text-pretty")}>
            {t(capabilities.host.platform === "darwin" ? "call.voiceSetup.subtitle" : "call.voiceSetup.subtitleKey")}
          </p>
          {state.config?.tts ? (
            <VoiceSettings bot={bot} onPatch={patch} />
          ) : (
            <div className="flex items-center justify-center gap-2 py-8 text-[13px] leading-[18px] text-ink/68">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              {t("call.voiceSetup.loading")}
            </div>
          )}
        </div>

        {/* Mounted before it has anything to say: a live region announces only changes made after it exists. */}
        <div role="status" aria-live="polite">
          {ready && (
            <div className="mx-4 mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2 py-1.5">
              <CheckCircle2 size={14} className="shrink-0 text-success" aria-hidden="true" />
              <span className="min-w-0 flex-1 text-[13px] leading-[18px] text-ink">
                {t("call.voiceSetup.ready", { name: callName })}
              </span>
              <button
                type="button"
                data-voice-setup-start
                onClick={onStartCall}
                className={cn(mdPrimaryCls, "gap-1.5")}
              >
                <Phone size={14} aria-hidden="true" />
                {t("call.voiceSetup.startCall")}
              </button>
            </div>
          )}
        </div>

        <footer className={cn(formFooterCls, "justify-start")}>
          <button
            type="button"
            data-voice-setup-all-settings
            onClick={openAllSettings}
            className="inline-flex items-center gap-0.5 rounded-sm pl-0.5 text-[12px] leading-4 tracking-[0.01em] text-ink/68 transition-[color] duration-[120ms] ease-[ease] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t("call.voiceSetup.allSettings")}
            <ChevronRight size={12} aria-hidden="true" />
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
