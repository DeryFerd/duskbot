// Android, until there is a Play listing: one line when a newer APK is out (latest.json "android"), once per version.
// It goes for good when closed or when the download opens; Settings > Check for updates keeps saying it.
import { useEffect, useState } from "react";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { loadLatestFeed } from "@/lib/release-notes";
import { apkBehind } from "../../../shared/release-notes";
import { X } from "../../icons";
import { haptic } from "../haptics";
import { usePlatform } from "../platform";

/** the update cards sit at the top of the home list, toned like its connection card: they push the list down, never cover it */
export const UPDATE_CARD = "mx-3 mb-3 flex min-h-12 items-center gap-2 rounded-[20px] bg-ink/[0.05] py-1.5 pe-1.5 ps-4";

const closedKey = (version: string) => `dusk-apk-line:${version}`;

export function useNewerApk(enabled: boolean): { version: string; url: string } | null {
  const platform = usePlatform();
  const [newer, setNewer] = useState<{ version: string; url: string } | null>(null);
  useEffect(() => {
    if (!enabled || platform.kind !== "android") return;
    let active = true;
    void loadLatestFeed().then((feed) => {
      if (!active || !feed?.android || !apkBehind(feed, { version: platform.appVersion })) return;
      try { if (localStorage.getItem(closedKey(feed.android.version))) return; } catch { /* shown */ }
      setNewer({ version: feed.android.version, url: feed.android.url });
    });
    return () => { active = false; };
  }, [enabled, platform.kind, platform.appVersion]);
  return newer;
}

export function ApkUpdateLine({ hidden = false }: { hidden?: boolean }) {
  const platform = usePlatform();
  const newer = useNewerApk(!hidden);
  const [closed, setClosed] = useState(false);
  if (!newer || closed || hidden) return null;
  const close = () => {
    try { localStorage.setItem(closedKey(newer.version), "1"); } catch { /* shown again next launch */ }
    setClosed(true);
  };
  return (
    <div role="status" data-apk-update="" className={UPDATE_CARD}>
      <p className="min-w-0 flex-1 text-[15px] text-ink">{t("mobile.updates.apkLine", { app: productName(), version: newer.version })}</p>
      <button type="button" className="mobile-press min-h-9 shrink-0 rounded-full bg-ink px-3.5 text-[15px] font-semibold text-app" onClick={() => { haptic("tap"); close(); void platform.openExternal(newer.url); }}>
        {t("mobile.updates.download")}
      </button>
      <button type="button" aria-label={t("mobile.updates.notNow")} className="mobile-press flex size-11 shrink-0 items-center justify-center rounded-full text-ink-secondary" onClick={() => { haptic("tap"); close(); }}>
        <X aria-hidden size={18} />
      </button>
    </div>
  );
}
