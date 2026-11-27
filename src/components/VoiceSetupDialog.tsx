import { useEffect, useId, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, ChevronRight, Loader2, Phone } from "../icons";

import { t } from "@/lib/i18n";
import { openBot, useStore, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { VoiceSettings } from "./VoiceSettings";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";
import { openBotSettings } from "./bot-panel/panel-link";
import { cn } from "@/lib/cn";
import { Icon } from "./Icon";
import { SIMPLE_BUTTONS } from "./SettingsPrimitives";
import "../styles/settings.css";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const VOICE_PICKER = '[data-voice-picker]:not([disabled]), [data-settings-select="voice"]:not([disabled])';
const FIRST_FIELD = "input:not([disabled]), select:not([disabled]), [data-settings-select]:not([disabled])";

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
      className="settings-scrim"
      data-settings-sheet
      data-settings-look="simple"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div aria-hidden="true" className="settings-backdrop" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
        data-voice-setup-dialog={bot.id}
        className="settings-dialog"
        style={{ width: "min(520px, 100vw - 32px)" }}
      >
        <section className="settings-panel min-h-0">
          <button type="button" onClick={close} aria-label={t("call.voiceSetup.close")} className="settings-close">
            <Icon name="close" size={14} />
          </button>
          <div className="settings-pane-header">
            <h2 id={titleId} className="settings-pane-title">
              {t("call.voiceSetup.title", { name: bot.name })}
            </h2>
          </div>
          <div className="settings-scroll">
            <div className={cn("settings-pane", SIMPLE_BUTTONS)} style={{ paddingBottom: 20 }}>
              <p id={subtitleId} className="m-0 px-2.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary text-pretty">
                {t(capabilities.host.platform === "darwin" ? "call.voiceSetup.subtitle" : "call.voiceSetup.subtitleKey")}
              </p>
              {state.config?.tts ? (
                <VoiceSettings bot={bot} onPatch={patch} />
              ) : (
                <div className="flex items-center justify-center gap-2 py-8 text-[13px] leading-[18px] text-ink-secondary">
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  {t("call.voiceSetup.loading")}
                </div>
              )}

              {/* Mounted before it has anything to say: a live region announces only changes made after it exists. */}
              <div role="status" aria-live="polite" className="empty:hidden">
                {ready && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-3">
                    <CheckCircle2 size={14} className="shrink-0 text-success" aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-[13px] leading-[18px] tracking-[0.015em] text-ink">
                      {t("call.voiceSetup.ready", { name: callName })}
                    </span>
                    <button type="button" data-voice-setup-start onClick={onStartCall} className="ui-button ui-button-primary">
                      <Phone size={13} aria-hidden="true" />
                      {t("call.voiceSetup.startCall")}
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                data-voice-setup-all-settings
                onClick={openAllSettings}
                className="-mt-2 inline-flex items-center gap-0.5 self-start rounded-sm px-3 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary transition-[color] duration-[120ms] ease-[ease] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {t("call.voiceSetup.allSettings")}
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
