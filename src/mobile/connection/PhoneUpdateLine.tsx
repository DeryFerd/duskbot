import { t } from "@/lib/i18n";
import { usePlatform } from "../platform";
import { storeUrl, usePhoneTooOld } from "./phone-update";
import { ApkUpdateLine, UPDATE_CARD } from "./ApkUpdateLine";

/** one short card at the top of the home list when this computer needs a newer phone app, with the way to the store;
 * otherwise, on Android, the card that a newer APK is out (closable). In the list, so it never covers a control. */
export function PhoneUpdateLine({ connection }: { connection: string | null }) {
  const platform = usePlatform();
  const old = usePhoneTooOld(connection);
  if (!old) return <ApkUpdateLine hidden={!connection} />;
  return (
    <div role="status" data-phone-update className={UPDATE_CARD}>
      <p className="min-w-0 flex-1 text-[15px] text-ink">{t("mobile.update.line")}</p>
      <button type="button" className="mobile-press min-h-9 shrink-0 rounded-full bg-ink px-3.5 text-[15px] font-semibold text-app" onClick={() => void platform.openExternal(storeUrl(platform.kind))}>
        {t("mobile.update.button")}
      </button>
    </div>
  );
}
