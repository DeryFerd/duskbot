import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Smartphone } from "../../icons";
import { t } from "@/lib/i18n";
import { ensurePairedPhone, registerPushForConnection, sendTestPush, usePushDelivering, usePushPairing, type PushTestResult } from "../connection/push";
import { haptic } from "../haptics";
import { setLiveActivityEnabled, useLiveActivityEnabled } from "../live-activity-setting";
import { usePlatform, type MobilePlatform } from "../platform";
import { SettingsRow, SettingsSwitch } from "./SettingsRow";

type Permission = "granted" | "denied" | "prompt";
const lastPermission = new WeakMap<MobilePlatform, Permission>();

/** Reply notifications and the Live Activity are separate: turning the Live Activity off leaves the notifications on. */
export function NotificationSettings() {
  const platform = usePlatform();
  const liveActivity = useLiveActivityEnabled();
  const pairing = usePushPairing(platform);
  const delivering = usePushDelivering();
  const [permission, setPermission] = useState<Permission | null>(() => lastPermission.get(platform) ?? null);
  const [test, setTest] = useState<PushTestResult | "sending" | null>(null);
  const check = useCallback(() => {
    void platform.pushPermission?.().then((answer) => { lastPermission.set(platform, answer); setPermission(answer); });
  }, [platform]);
  useEffect(() => {
    check();
    return platform.onResume?.(check);
  }, [platform, check]);

  const allow = async () => {
    haptic("pick");
    if (permission === "denied") { await platform.camera?.openSettings?.(); return; }
    await registerPushForConnection(platform, { prompt: true });
    check();
  };
  const sendTest = async () => {
    haptic("pick");
    setTest("sending");
    setTest(await sendTestPush(platform));
  };

  // a phone the place cannot push to says so, with the way to fix it, and is never asked for notifications
  if (pairing === "not-paired" || pairing === "old-server") return <NotPairedCard platform={platform} pairing={pairing} />;
  return <>
    {permission && permission !== "granted" && (
      <SettingsRow icon={<BellOff />} label={t("mobile.settings.allowNotifications")} detail={t(permission === "denied" ? "mobile.settings.allowNotificationsDenied" : "mobile.settings.allowNotificationsDetail")} onClick={() => { void allow(); }} />
    )}
    {permission === "granted" && pairing === "paired" && delivering === false && <UndeliverableCard platform={platform} />}
    {permission === "granted" && pairing === "paired" && delivering !== false && (
      <SettingsRow icon={<Bell />} label={t("mobile.settings.push.test")} detail={test ? t(`mobile.settings.push.test.${test}`) : undefined} onClick={test === "sending" ? undefined : () => { void sendTest(); }} chevron={false} />
    )}
    {platform.turnActivity && (
      <SettingsSwitch icon={<Smartphone />} label={t("mobile.settings.liveActivity")} detail={t("mobile.settings.liveActivityDetail")} checked={liveActivity} onChange={(on) => { haptic("toggle"); setLiveActivityEnabled(on); }} />
    )}
  </>;
}

/** title, one plain sentence, one button that fixes it: pairing this signed-in phone with the place it is on */
function NotPairedCard({ platform, pairing }: { platform: MobilePlatform; pairing: "not-paired" | "old-server" }) {
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const pair = async () => {
    haptic("pick");
    setBusy(true);
    try {
      if (await ensurePairedPhone(platform, { again: true })) await registerPushForConnection(platform, { prompt: true });
      else setTried(true);
    } finally { setBusy(false); }
  };
  const sentence = pairing === "old-server" ? "mobile.settings.push.notPaired.oldServer" : tried ? "mobile.settings.push.notPaired.refused" : "mobile.settings.push.notPaired.body";
  return (
    <div data-push-not-paired="" className="flex items-start gap-3 px-4 py-3">
      <BellOff aria-hidden className="mt-0.5 size-5 shrink-0 text-ink-secondary" />
      <div className="min-w-0 flex-1">
        <p className="text-[16px] font-medium text-ink">{t("mobile.settings.push.notPaired.title")}</p>
        <p aria-live="polite" className="mt-0.5 text-[13px] leading-[18px] text-ink-secondary">{t(sentence)}</p>
        <button type="button" disabled={busy} onClick={() => { void pair(); }} className="mobile-press mt-2.5 rounded-full bg-ink px-3.5 py-1.5 text-[15px] font-semibold text-app disabled:opacity-60">
          {t(pairing === "old-server" || tried ? "mobile.settings.push.notPaired.again" : "mobile.settings.push.notPaired.pair")}
        </button>
      </div>
    </div>
  );
}

/** a paired, registered phone whose place has no way to send it a push: the server owner's fix, and a check again */
function UndeliverableCard({ platform }: { platform: MobilePlatform }) {
  const [busy, setBusy] = useState(false);
  const again = async () => {
    haptic("pick");
    setBusy(true);
    try { await registerPushForConnection(platform, { again: true }); } finally { setBusy(false); }
  };
  return (
    <div data-push-undeliverable="" className="flex items-start gap-3 px-4 py-3">
      <BellOff aria-hidden className="mt-0.5 size-5 shrink-0 text-ink-secondary" />
      <div className="min-w-0 flex-1">
        <p className="text-[16px] font-medium text-ink">{t("mobile.settings.push.undeliverable.title")}</p>
        <p aria-live="polite" className="mt-0.5 text-[13px] leading-[18px] text-ink-secondary">{t("mobile.settings.push.undeliverable.body")}</p>
        <button type="button" disabled={busy} onClick={() => { void again(); }} className="mobile-press mt-2.5 rounded-full bg-ink px-3.5 py-1.5 text-[15px] font-semibold text-app disabled:opacity-60">
          {t("mobile.settings.push.notPaired.again")}
        </button>
      </div>
    </div>
  );
}
