// Settings > Check for updates on the phone: this app's version and the server's, whether either is behind, and the one
// tap that fixes it (the newest APK, the App Store, or the server's own update). Settings > What's new: the changelog.
import { useCallback, useEffect, useState } from "react";
import { RELEASES_URL } from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { PHONE_AREAS, loadLatestFeed, useReleases, type LatestFeed, type Release } from "@/lib/release-notes";
import { serverCheckPhase, type ServerUpdateCheck } from "@/lib/server-update";
import { UpdateArt, UpdateNotes } from "@/components/WhatsNewDialog";
import { api } from "@/state/store";
import { apkBehind } from "../../../shared/release-notes";
import { ExternalLink, Server, Smartphone } from "../../icons";
import { haptic } from "../haptics";
import { usePlatform, type MobilePlatform } from "../platform";
import { storeUrl } from "../connection/phone-update";
import { Sheet } from "../Sheet";
import { SettingsRow, SettingsSection } from "./SettingsRow";

type Phone = { state: "checking" } | { state: "done"; feed: LatestFeed | null };

/** what the phone's own row says: Android compares itself with latest.json, an iPhone is updated by the App Store */
export function phoneAppRow(kind: MobilePlatform["kind"], version: string, phone: Phone): { detail?: string; value?: string; url?: string } {
  if (kind === "ios") return { detail: t("mobile.updates.appStore"), value: t("mobile.updates.openStore"), url: storeUrl("ios") };
  if (kind !== "android") return {};
  if (phone.state === "checking") return { value: t("common.checking") };
  const feed = phone.feed?.android;
  if (!phone.feed) return { detail: t("sidebar.update.checkFailed"), value: t("settings.updates.check") };
  if (!feed) return {};
  if (apkBehind(phone.feed, { version })) return { detail: t("mobile.updates.apkOut", { version: feed.version }), value: t("mobile.updates.download"), url: feed.url };
  return { detail: t("sidebar.update.upToDate") };
}

type ServerRow = { state: "checking" } | { state: "failed" } | { state: "done"; check: ServerUpdateCheck } | { state: "updating" };

/** what the server's row says, and what its tap does */
export function serverRow(row: ServerRow): { label: string; detail?: string; value?: string; act?: "apply" | "copy" | "release" | "check" } {
  if (row.state === "checking") return { label: t("mobile.updates.serverTitle"), value: t("common.checking") };
  if (row.state === "failed") return { label: t("mobile.updates.serverTitle"), detail: t("sidebar.update.checkFailed"), value: t("settings.updates.check"), act: "check" };
  if (row.state === "updating") return { label: t("mobile.updates.serverTitle"), detail: t("settings.updates.updatingServer") };
  const { check } = row;
  const label = t("mobile.updates.serverVersion", { version: check.current });
  if (check.install === "managed") return { label, detail: t("sidebar.update.managed") };
  if (check.install === "desktop") return { label, detail: t("mobile.updates.withDesktop", { app: productName() }), ...(check.available && check.latest ? { detail: t("mobile.updates.serverOut", { version: check.latest }) } : {}) };
  if (serverCheckPhase(check, check.current) !== "available" || !check.latest) return { label, detail: t("sidebar.update.upToDate") };
  const out = t("mobile.updates.serverOut", { version: check.latest });
  if (check.compose?.supported) return { label, detail: out, value: t("settings.updates.updateNow"), act: "apply" };
  if (check.pinned) return { label, detail: `${out} ${t("settings.updates.pinned", { image: check.pinned })}` };
  if (check.command) return { label, detail: `${out} ${t("sidebar.update.how", { command: check.command })}`, value: t("mobile.updates.copy"), act: "copy" };
  return { label, detail: out, ...(check.releaseUrl ? { value: t("settings.simple.updates.seeRelease"), act: "release" as const } : {}) };
}

export function UpdatesPage({ onClose }: { onClose: () => void }) {
  const platform = usePlatform();
  const [phone, setPhone] = useState<Phone>({ state: "checking" });
  const [server, setServer] = useState<ServerRow>({ state: "checking" });
  const [copied, setCopied] = useState(false);
  const checkPhone = useCallback(() => {
    if (platform.kind !== "android") return;
    setPhone({ state: "checking" });
    void loadLatestFeed().then((feed) => setPhone({ state: "done", feed }));
  }, [platform.kind]);
  const checkServer = useCallback(() => {
    setServer({ state: "checking" });
    void api<ServerUpdateCheck>("/api/updates/check", { timeoutMs: 20_000 }).then((check) => setServer({ state: "done", check }), () => setServer({ state: "failed" }));
  }, []);
  useEffect(() => { checkPhone(); checkServer(); }, [checkPhone, checkServer]);

  const app = phoneAppRow(platform.kind, platform.appVersion, phone);
  const srv = serverRow(server);
  const onApp = app.url ? () => { haptic("tap"); void platform.openExternal(app.url!); }
    : platform.kind === "android" && phone.state === "done" && !phone.feed ? () => { haptic("tap"); checkPhone(); } : undefined;
  const onServer = srv.act ? () => {
    haptic("tap");
    if (server.state !== "done" && srv.act !== "check") return;
    if (srv.act === "check") return checkServer();
    const check = (server as { check: ServerUpdateCheck }).check;
    if (srv.act === "release" && check.releaseUrl) return void platform.openExternal(check.releaseUrl);
    if (srv.act === "copy" && check.command) return void (platform.writeClipboard?.(check.command) ?? copyText(check.command).then((result) => result === "copied")).then((ok) => setCopied(ok));
    if (srv.act === "apply") {
      setServer({ state: "updating" });
      void api("/api/updates/apply", { method: "POST", body: "{}", timeoutMs: 30_000 }).catch(() => setServer({ state: "failed" }));
    }
  } : undefined;
  return (
    <Sheet open onClose={onClose} title={t("settings.updates.check")}>
      <div data-updates-page="" className="pb-6">
        {platform.kind !== "web" && (
          <SettingsSection card title={t("mobile.updates.thisPhone")}>
            <SettingsRow icon={<Smartphone />} label={`${productName()} ${platform.appVersion}`} detail={app.detail} value={app.value} onClick={onApp} chevron={false} />
          </SettingsSection>
        )}
        <SettingsSection card title={t("mobile.updates.server")}>
          <SettingsRow icon={<Server />} label={srv.label} detail={srv.detail} value={copied && srv.act === "copy" ? t("mobile.updates.copied") : srv.value} onClick={onServer} chevron={false} />
        </SettingsSection>
      </div>
    </Sheet>
  );
}

/** the newest notes for the phone, as the desktop's What's new: the scene, then New, Better and Fixed */
export function WhatsNewPage({ onClose, notes, updatedTo }: { onClose: () => void; notes?: readonly Release[]; updatedTo?: string }) {
  const platform = usePlatform();
  const read = useReleases(PHONE_AREAS, { native: platform.native, enabled: !notes });
  const releases = notes ?? read?.slice(0, 1) ?? null;
  const version = releases?.[0]?.version;
  return (
    <Sheet open onClose={onClose} title={t("whatsNew.title")}>
      <div data-whats-new="" data-whats-new-updated={updatedTo ? "" : undefined} className="pb-6">
        {releases && version && (
          <div className="mx-4">
            <UpdateArt updated={Boolean(updatedTo)} className="rounded-[16px]" />
            <div className="px-1 pt-4">
              <UpdateNotes phone releases={releases} label={updatedTo ? t("updates.updated", { version: updatedTo }) : t("whatsNew.version", { version })} />
            </div>
            <button type="button" data-whats-new-done="" onClick={onClose}
              className="mt-5 flex h-12 w-full cursor-pointer items-center justify-center rounded-full border-0 bg-ink text-[16px] font-semibold text-app active:opacity-80">
              {t("whatsNew.gotIt")}
            </button>
          </div>
        )}
        {releases && !version && <p className="mx-8 mb-2 text-[15px] text-ink-secondary">{t("whatsNew.none")}</p>}
        {releases && (
          <SettingsSection card>
            <SettingsRow icon={<ExternalLink />} label={t("whatsNew.allReleases")} onClick={() => void platform.openExternal(RELEASES_URL)} chevron={false} />
          </SettingsSection>
        )}
      </div>
    </Sheet>
  );
}
