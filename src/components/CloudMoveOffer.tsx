import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CloudSendNotice } from "../../electron/cloud-send.mjs";
import { MOVE_LINE } from "../../electron/cloud-send-parts.mjs";
import { Loader2, X } from "../icons";
import { track } from "@/lib/analytics";
import { openedFromTheApp } from "@/lib/cloud-welcome";
import { cloudFirstRunDue, useWelcomeOnScreen } from "@/lib/onboarding";
import { moveOfferBridge, moveProgress, moveSheetState, offerAsk, type MoveSheetState } from "@/lib/cloud-move-offer";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { CloudMoveScene } from "./CloudMoveScene";
import { WhatMovesLine } from "./WhatMoves";
import { useCloudSendNotice } from "./CloudSendStrip";
import { useDialogKeys } from "./ui/GrokDialog";
import { SIMPLE_BUTTONS } from "./SettingsPrimitives";
import "../styles/settings.css";
import { ScrimMotion, SheetMotion } from "./ui/SheetMotion";
import { TOP_BAR_PILL, TOP_BAR_PILL_CLOSE, TopBarNotice } from "./TopBarNotice";

export const QUIET_BUTTON = "inline-flex h-9 shrink-0 cursor-pointer items-center rounded-full px-3 text-[13px] font-medium text-ink-secondary transition-[color,background-color] duration-[120ms] ease-[ease] hover:bg-ink/6 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50";

/**
 * Moving this computer's bots to the person's dusk cloud, in one small sheet: it asks once by itself, then follows the move
 * as the bots hop across, and ends with All moved. Closed while it asks, a pill in the top bar asks instead; closed too,
 * Settings → Computer keeps Move (CloudMoveSettings). On My Cloud's page All moved is that pill, never a sheet over its chat.
 */
export function CloudMoveOffer({ cloudHome = false }: { cloudHome?: boolean }) {
  const { state } = useStore();
  const bridge = moveOfferBridge();
  const [notice, setNotice] = useCloudSendNotice(bridge);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const declined = useRef(false);
  const shown = useRef<string | null>(null);
  const furthest = useRef(0);
  const welcome = useWelcomeOnScreen() || (cloudHome && cloudFirstRunDue(state.config?.onboarding, openedFromTheApp()));
  const waits = welcome || !state.connected || !state.config || state.appSettingsOpen || state.settingsOpen || state.pluginsOpen || state.shortcutsOpen;
  const ask = waits ? null : offerAsk(notice);
  const moving = moveSheetState(notice?.move) ?? (startFailed ? "failed" : null);
  const sheet: MoveSheetState | null = welcome ? null : moving === "done" ? "done" : open ? moving ?? (notice?.offer ? "ask" : null) : null;

  useEffect(() => { if (ask === "prompt" && !open && !declined.current) setOpen(true); }, [ask, open]);
  useEffect(() => {
    const surface = sheet === "ask" ? "prompt" : !sheet && ask === "banner" ? "banner" : null;
    if (!surface || shown.current === surface) return;
    shown.current = surface;
    track(`cloud_move_${surface}`, { action: "shown" });
  }, [sheet, ask]);

  if (!bridge?.moveOfferAccept || !notice) return null;
  furthest.current = Math.max(furthest.current, moveProgress(notice.move));

  const run = (work: () => Promise<CloudSendNotice> | undefined) => {
    if (busy) return;
    const started = work();
    if (!started) return;
    setBusy(true); setStartFailed(false);
    void started.then(setNotice).catch(() => setStartFailed(true)).finally(() => setBusy(false));
  };
  const accept = (from: "prompt" | "banner") => { setOpen(true); run(() => bridge.moveOfferAccept!(from)); };
  const retry = () => (startFailed ? accept("prompt") : run(() => bridge.moveRetry?.()));
  const later = () => { declined.current = true; setOpen(false); void bridge.moveOfferDismiss?.("prompt").then(setNotice).catch(() => {}); };
  const hide = () => { setOpen(false); setStartFailed(false); };
  const openCloud = () => {
    if (!cloudHome && bridge.moveOpen) { run(() => bridge.moveOpen!()); return; }
    setOpen(false);
    void bridge.dismiss(MOVE_LINE).then(setNotice).catch(() => {});
  };

  if (sheet && !(sheet === "done" && cloudHome)) {
    return <MoveSheet state={sheet} progress={furthest.current} busy={busy}
      onClose={sheet === "ask" ? later : sheet === "done" ? openCloud : hide}
      onMove={() => accept("prompt")} onLater={later} onHide={hide} onRetry={retry} onOpen={openCloud} />;
  }
  // on dusk cloud's own page the move is already where it ended: a line in the top bar, never a sheet over the cloud's chat
  const line = sheet === "done" ? "done" : ask === "banner" && !moving ? "banner" : null;
  return <TopBarNotice noticeKey={line}>
    {line === "done" && <div role="status" data-cloud-move-done="" className={TOP_BAR_PILL}>
      <span className="min-w-0 truncate">{t("cloudMoveOffer.done")} · <span className="text-ink-secondary">{t("cloudMoveOffer.doneLine")}</span></span>
      <button type="button" aria-label={t("cloudMoveOffer.close")} onClick={openCloud} className={TOP_BAR_PILL_CLOSE}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>}
    {line === "banner" && <div role="region" aria-label={t("cloudMoveOffer.banner")} data-cloud-move-banner="" className={TOP_BAR_PILL}>
      <span className="min-w-0 truncate">{t("cloudMoveOffer.banner")}</span>
      <button type="button" data-cloud-move-accept="banner" disabled={busy} aria-busy={busy || undefined} onClick={() => accept("banner")}
        className="ml-1 inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 font-semibold text-accent-text transition-[background-color] duration-[120ms] ease-[ease] hover:bg-ink/6 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
        {busy && <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />}
        {t("cloudMoveOffer.move")}
      </button>
      <button type="button" aria-label={t("cloudMoveOffer.close")} onClick={() => void bridge.moveOfferDismiss?.("banner").then(setNotice).catch(() => {})} className={TOP_BAR_PILL_CLOSE}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>}
  </TopBarNotice>;
}

function MoveSheet({ state, progress, busy, onClose, onMove, onLater, onHide, onRetry, onOpen }: {
  state: MoveSheetState; progress: number; busy: boolean;
  onClose: () => void; onMove: () => void; onLater: () => void; onHide: () => void; onRetry: () => void; onOpen: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const lineId = useId();
  useDialogKeys(sheet, onClose);
  const line = state === "ask" ? t("cloudMoveOffer.ask") : state === "moving" ? t("cloudMoveOffer.moving")
    : state === "failed" ? t("cloudMoveOffer.failed") : t("cloudMoveOffer.doneLine");
  const spinner = busy && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />;
  return createPortal(
    <div data-settings-sheet data-settings-look="simple" className="settings-scrim">
      <ScrimMotion aria-hidden="true" data-modal-scrim className="settings-backdrop" onMouseDown={onClose} />
      <SheetMotion ref={sheet} role="dialog" aria-modal="true" aria-labelledby={lineId} tabIndex={-1} data-cloud-move={state}
        className="settings-dialog" style={{ width: "min(400px, 100vw - 32px)" }}>
        <CloudMoveScene progress={progress} done={state === "done"} className="w-full pt-3" />
        <div className={cn("settings-pane", SIMPLE_BUTTONS)} style={{ gap: 14, paddingTop: 8, paddingBottom: 20 }}>
          <div className="flex flex-col gap-1">
            {state === "done" && <h2 className="settings-pane-title m-0">{t("cloudMoveOffer.done")}</h2>}
            <p id={lineId} role={state === "ask" ? undefined : "status"}
              className={cn("m-0 px-2.5 text-pretty text-[13px] leading-[18px] tracking-[0.015em]", state === "done" ? "text-ink-secondary" : "text-ink")}>{line}</p>
          </div>
          {state === "ask" && <div className="px-2.5"><WhatMovesLine /></div>}
          {(state === "moving" || state === "failed") && <div className="mx-2.5 h-1 overflow-hidden rounded-full bg-ink/[0.08]">
            <div data-cloud-move-progress={Math.round(progress * 100)} className={cn("h-full origin-left rounded-full transition-transform duration-700 ease-out motion-reduce:transition-none", state === "failed" ? "bg-warning" : "bg-accent")}
              style={{ transform: `scaleX(${Math.max(0.04, progress)})` }} />
          </div>}
          <div className="flex items-center justify-end gap-2 px-2.5">
            {state === "ask" && <>
              <button type="button" className="ui-button" disabled={busy} onClick={onLater}>{t("cloudMoveOffer.later")}</button>
              <button type="button" data-autofocus data-cloud-move-accept="prompt" className="ui-button ui-button-primary" disabled={busy} aria-busy={busy || undefined} onClick={onMove}>{spinner}{t("cloudMoveOffer.move")}</button>
            </>}
            {state === "moving" && <button type="button" data-autofocus className="ui-button" onClick={onHide}>{t("cloudMoveOffer.hide")}</button>}
            {state === "failed" && <>
              <button type="button" className="ui-button" onClick={onHide}>{t("cloudMoveOffer.hide")}</button>
              <button type="button" data-autofocus className="ui-button ui-button-primary" disabled={busy} aria-busy={busy || undefined} onClick={onRetry}>{spinner}{t("cloudMoveOffer.tryAgain")}</button>
            </>}
            {state === "done" && <button type="button" data-autofocus className="ui-button ui-button-primary" disabled={busy} aria-busy={busy || undefined} onClick={onOpen}>{spinner}{t("cloudMoveOffer.open")}</button>}
          </div>
        </div>
      </SheetMotion>
    </div>,
    document.body,
  );
}
