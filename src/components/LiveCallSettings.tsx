import { useCallback, useId, useState } from "react";

import { LIVE_VOICE_OPTIONS } from "../../shared/live-call";
import { t } from "@/lib/i18n";
import { liveDisclosure } from "@/lib/call-mode";
import { api, useStore, type ConfigStatus } from "@/state/store";
import type { LiveSettings } from "../../shared/wire";
import { LiveKeySetup } from "./LiveKeySetup";
import { LiveProviderSettings } from "./LiveProviderSettings";
import { KeysLink } from "./keys/KeysLink";
import { SettingsSelect } from "./SettingsSelect";
import { SettingRow, SettingsRows, Switch } from "./SettingsPrimitives";
import { rowButtonCls } from "./ui/GrokDialog";
import "../styles/settings.css";
import { friendlyError } from "@/lib/plain-error";

const IDLE_CHOICES = [1, 2, 3, 5, 10, 15, 30, 60];

export function LiveCallSettings({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const live: LiveSettings = state.config?.live ?? { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
  const [saving, setSaving] = useState(false);
  const [changingKey, setChangingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typedHintId = useId();
  // Stable, so this callback ref runs once when the popover mounts, not on every save.
  const focusOnOpen = useCallback((dialog: HTMLDivElement | null) => {
    dialog?.querySelector<HTMLElement>("select, input, button")?.focus();
  }, []);
  const azure = live.provider === "azure";
  const voice = live.voice || "marin";
  const known = LIVE_VOICE_OPTIONS.some((option) => option.id === voice);

  const save = async (patch: Partial<Pick<LiveSettings, "voice" | "readTypedReplies" | "idleMinutes">>) => {
    setSaving(true);
    setError(null);
    try {
      const body = await api<{ live: LiveSettings }>("/api/live/settings", { method: "PATCH", body: JSON.stringify(patch) });
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, live: body.live } });
    } catch (saveError) {
      setError(friendlyError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = window.duskDesktop?.setCredential
        ? await window.duskDesktop.setCredential("openaiLiveKey", "")
        : await api("/api/config", { method: "PUT", body: JSON.stringify({ live: { key: "" } }) });
      dispatch({ type: "configStatus", config: status });
    } catch (removeError) {
      setError(friendlyError(removeError));
    } finally {
      setSaving(false);
    }
  };

  const keyHint = live.keySource !== "live" && azure
    ? t("call.live.azureNeedsKey")
    : live.keySource !== "live"
      ? <>{t(live.keySource === "openai" ? "call.live.keyFromApiKeys" : "call.live.needsKey")} <KeysLink id="openai" purpose="liveCalls" /></>
      : undefined;
  return (
    <div
      ref={focusOnOpen}
      role="dialog"
      tabIndex={-1}
      aria-label={t("call.live.settings")}
      data-settings-look="simple"
      className="flex w-[360px] max-w-[90vw] flex-col gap-2.5 rounded-[14px] bg-app p-2 text-[13px] text-ink shadow-lg"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <LiveProviderSettings />
      <SettingsRows>
        <SettingRow title={t("call.live.voice")} subtitle={t("call.live.voiceNext")}>
          <SettingsSelect aria-label={t("call.live.voice")} value={voice} disabled={saving} onChange={(event) => void save({ voice: event.target.value })}>
            {!known && <option value={voice}>{voice}</option>}
            {LIVE_VOICE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </SettingsSelect>
        </SettingRow>
        <SettingRow title={t("call.live.readTyped")} subtitle={<span id={typedHintId}>{t("call.live.readTypedHint")}</span>}>
          <Switch
            checked={live.readTypedReplies}
            disabled={saving}
            aria-label={t("call.live.readTyped")}
            aria-describedby={typedHintId}
            onClick={() => void save({ readTypedReplies: !live.readTypedReplies })}
          />
        </SettingRow>
        <SettingRow title={t("call.live.idle")}>
          <SettingsSelect aria-label={t("call.live.idle")} value={String(live.idleMinutes)} disabled={saving} onChange={(event) => void save({ idleMinutes: Number(event.target.value) })}>
            {[...new Set([...IDLE_CHOICES, live.idleMinutes])].sort((a, b) => a - b).map((minutes) => (
              <option key={minutes} value={String(minutes)}>{minutes}</option>
            ))}
          </SettingsSelect>
        </SettingRow>
        <SettingRow title={t(azure ? "call.live.azureKey" : "call.live.key")} subtitle={keyHint}>
          <span className="flex gap-2">
            <button type="button" className={rowButtonCls} onClick={() => setChangingKey((open) => !open)}>
              {t("call.live.keyChange")}
            </button>
            {live.keySource === "live" && (
              <button type="button" className={rowButtonCls} disabled={saving} onClick={() => void removeKey()}>
                {t("call.live.keyRemove")}
              </button>
            )}
          </span>
        </SettingRow>
      </SettingsRows>
      {changingKey && <LiveKeySetup compact onSaved={() => setChangingKey(false)} />}
      <p className="m-0 px-3 text-[12px] leading-4 text-ink-tertiary">{liveDisclosure({ cloudHome: state.config?.cloudHome === true, azure })} {t(azure ? "call.live.azureCost" : "call.live.cost")}</p>
      {error && <p role="alert" className="m-0 px-3 text-[12px] leading-4 text-danger">{error}</p>}
    </div>
  );
}
