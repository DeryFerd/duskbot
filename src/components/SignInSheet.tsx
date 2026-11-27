import { ModalLayer } from "./ui/ModalLayer";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { cn } from "@/lib/cn";
import { SIMPLE_BUTTONS } from "./SettingsPrimitives";
import "../styles/settings.css";
import { t } from "@/lib/i18n";
import { stopWaitingInBrowser, useWaitingInBrowser } from "@/lib/account-intent";
import { signedInNow } from "@/lib/sign-in-sheet";

/** The one calm state while an account step goes on in the browser: what to do there, Open again and Cancel. It closes
 *  by itself when the app is signed in (the person may finish in the browser and never come back here). */
export function ContinueInBrowserSheet({ kind, onClose }: { kind: "signin" | "upgrade" | "billing"; onClose: () => void }) {
  const bridge = window.duskDesktop?.cloudAccount;
  const [busy, setBusy] = useState(false);
  return <ModalLayer><div data-settings-sheet data-settings-look="simple" className="settings-scrim">
    <div aria-hidden="true" className="settings-backdrop" />
    <div role="dialog" aria-modal="true" aria-labelledby="continue-browser-title" data-continue-in-browser={kind} className="settings-dialog" style={{ width: "min(420px, 100vw - 32px)" }}>
      <section className="settings-panel min-h-0">
        <button type="button" onClick={onClose} aria-label={t("accounts.close")} className="settings-close"><Icon name="close" size={14} /></button>
        <div className="settings-pane-header">
          <h2 id="continue-browser-title" className="settings-pane-title">{t("continueBrowser.title")}</h2>
        </div>
        <div className="settings-scroll">
          <div className={cn("settings-pane", SIMPLE_BUTTONS)} style={{ paddingBottom: 20 }}>
            <div className="flex flex-col gap-1.5"><p className="m-0 px-2.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary text-pretty">{t(kind === "upgrade" ? "continueBrowser.upgrade" : kind === "billing" ? "continueBrowser.billing" : "continueBrowser.signin")}</p>
            <p className="m-0 px-2.5 text-[12px] leading-4 text-ink-tertiary text-pretty">{t("continueBrowser.note")}</p></div>
            <div className="flex flex-wrap gap-2 px-2.5">
              <button type="button" data-continue-open="" className="ui-button ui-button-primary" disabled={busy} onClick={() => { setBusy(true); void bridge?.reopen().finally(() => setBusy(false)); }}>{t("continueBrowser.open")}</button>
              <button type="button" data-continue-cancel="" className="ui-button" disabled={busy} onClick={() => { void bridge?.cancel().catch(() => {}); onClose(); }}>{t("continueBrowser.cancel")}</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div></ModalLayer>;
}

/** Mounted once on the app's page: shows the sheet while the app waits on the browser, and goes on once signed in. */
export function SignInSheetHost() {
  const waiting = useWaitingInBrowser();
  const bridge = window.duskDesktop?.cloudAccount;
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    if (!waiting || !bridge) return;
    let alive = true;
    const look = (status: string | undefined, signedIn: boolean) => {
      if (!alive) return;
      if (signedIn) { stopWaitingInBrowser(); signedInNow(); return; }
      setConnecting(status === "connecting");
      if (status !== "connecting") stopWaitingInBrowser();
    };
    void bridge.state().then((state) => look(state.status, Boolean(state.account) && state.status === "connected"), () => {});
    const off = bridge.onState((state) => look(state.status, Boolean(state.account) && state.status === "connected"));
    return () => { alive = false; off(); };
  }, [waiting, bridge]);
  if (!waiting || !connecting) return null;
  return <ContinueInBrowserSheet kind={waiting.kind} onClose={stopWaitingInBrowser} />;
}
