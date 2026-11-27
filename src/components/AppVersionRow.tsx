import { useEffect, useState, type ReactNode } from "react";

import { appVersion, openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";

import type { AppUpdateBridge, AppUpdateState } from "../../electron/app-update.mjs";
import { productName } from "../lib/brand";
import { ItemRow, NavRow } from "./ListRows";

/** this app's own updater: main hands it to this computer's page (also while it is a client of another server), My Cloud's
 * home page, and a place of the person's own open in the window */
function ownBridge() {
  return window.duskDesktop?.appUpdate;
}

/** the page shows a server other than this app's own: the app's row is named as the app, and the server keeps its own row */
export function showsOtherServer(): boolean {
  return window.duskDesktop?.app?.ownPage === false || window.duskDesktop?.remoteClient?.active === true;
}

/**
 * Settings > Version on this app's own page (electron/app-update.mjs). A mac or Windows app that installs its own updates
 * (or a Linux AppImage) checks, downloads and restarts here, and always says how a check went; a source checkout says it is a dev build.
 * Anything else (a .deb, a server's page, the browser) keeps `fallback`, the server's check.
 */
export function AppVersionRow({ fallback, bridge = ownBridge(), other = showsOtherServer() }: { fallback: ReactNode; bridge?: AppUpdateBridge; other?: boolean }) {
  const [update, setUpdate] = useState<AppUpdateState | null>(bridge ? null : { ready: null, mode: "notice" });
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let heard = false;
    const unsubscribe = bridge.onState(state => { if (active) { heard = true; setUpdate(state); } });
    void bridge.state().then(state => { if (active && !heard) setUpdate(state); }, () => { if (active && !heard) setUpdate({ ready: null, mode: "notice" }); });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  if (!update) return null;
  if (update.mode === "dev") {
    return <ItemRow data-settings-row="app-version" title={t("appUpdate.devTitle", { app: productName() })} hint={t("appUpdate.devHint")} />;
  }
  if (update.mode !== "self" || !bridge) return <>{fallback}</>;
  // on another server's page the app's update is its own row, and that server's update stays beside it
  if (other) return <><OwnAppRow bridge={bridge} update={update} other />{fallback}</>;
  return <OwnAppRow bridge={bridge} update={update} other={false} />;
}

function OwnAppRow({ bridge, update, other }: { bridge: AppUpdateBridge; update: AppUpdateState; other: boolean }) {
  const [asked, setAsked] = useState<"checking" | "done" | null>(null);
  const [restarting, setRestarting] = useState(false);
  const version = window.duskDesktop?.app?.version ?? appVersion();
  const title = other ? t("settings.updates.appVersion", { app: productName(), version }) : `${productName()} ${version}`;
  const ready = update.ready;
  if (ready) {
    const restart = () => {
      setRestarting(true);
      void bridge.restart().then(ok => { if (!ok) setRestarting(false); }, () => setRestarting(false));
    };
    return <NavRow data-settings-open="app-update" title={title} hint={t("appUpdate.ready", { version: ready })} value={restarting ? t("settings.updates.restartingShort") : t("appUpdate.restart")} drill={false} disabled={restarting} onClick={restart} />;
  }
  // an update this app can't install by itself says what to do, as the sidebar does, never "the latest version"
  if (update.available && update.blocked === "move") {
    return <NavRow data-settings-open="app-update" title={title} hint={t("appUpdate.moveHint", { app: productName() })} value={t("appUpdate.move")} drill={false} onClick={() => void bridge.move?.()} />;
  }
  if (update.manual) {
    const open = () => void (bridge.open ? bridge.open() : openExternalLink("https://dusk.bot/download"));
    return <NavRow data-settings-open="app-update" title={title} hint={t("appUpdate.manualHint", { version: update.manual.version })} value={t("appUpdate.manual", { version: update.manual.version })} drill={false} onClick={open} />;
  }
  if (update.available && update.retrying) {
    return <NavRow data-settings-open="app-update" title={title} hint={`${t("appUpdate.retrying")} · ${t("appUpdate.retryingHint")}`} value={t("common.checking")} drill={false} disabled onClick={() => {}} />;
  }
  if (update.available && (update.progress != null || update.checking)) {
    const percent = update.progress == null ? null : Math.round(update.progress * 100);
    const hint = percent === null ? t("appUpdate.downloading", { version: update.available }) : `${t("appUpdate.downloading", { version: update.available })} · ${t("appUpdate.percent", { percent })}`;
    return <NavRow data-settings-open="app-update" title={title} hint={hint} value={t("common.checking")} drill={false} disabled onClick={() => {}} />;
  }
  const checking = asked === "checking" || update.checking === true;
  const hint = asked === "done" && !checking ? (update.failed ? t("sidebar.update.checkFailed") : t("appUpdate.latest")) : undefined;
  const check = () => {
    setAsked("checking");
    void bridge.download?.().then(() => setAsked("done"), () => setAsked("done"));
  };
  return <NavRow data-settings-open="app-update" title={title} hint={hint} value={checking ? t("common.checking") : t("settings.updates.check")} drill={false} disabled={checking} onClick={check} />;
}
