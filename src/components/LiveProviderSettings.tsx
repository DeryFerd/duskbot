import { useState } from "react";

import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import type { LiveProvider, LiveSettings } from "../../shared/wire";
import { cn } from "@/lib/cn";
import { SettingsSelect } from "./SettingsSelect";
import { SettingRow, SettingsRows } from "./SettingsPrimitives";
import { rowPrimaryCls, textFieldCls } from "./ui/GrokDialog";
import { friendlyError } from "@/lib/plain-error";

type ProviderPatch = Partial<Pick<LiveSettings, "provider" | "azureEndpoint" | "azureDeployment">>;

export function LiveProviderSettings() {
  const { state, dispatch } = useStore();
  const live: LiveSettings = state.config?.live ?? { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
  const provider: LiveProvider = live.provider ?? "openai";
  const [endpoint, setEndpoint] = useState(live.azureEndpoint ?? "");
  const [deployment, setDeployment] = useState(live.azureDeployment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const azureChanged = endpoint.trim() !== (live.azureEndpoint ?? "") || deployment.trim() !== (live.azureDeployment ?? "");

  const save = async (patch: ProviderPatch) => {
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

  return (
    <div data-settings-look="simple" className="flex flex-col gap-2">
      <SettingsRows>
        <SettingRow title={t("call.live.provider")}>
          <SettingsSelect aria-label={t("call.live.provider")} value={provider} disabled={saving} onChange={(event) => void save({ provider: event.target.value as LiveProvider })}>
            <option value="openai">{t("call.live.provider.openai")}</option>
            <option value="azure">{t("call.live.provider.azure")}</option>
          </SettingsSelect>
        </SettingRow>
        {provider === "azure" && (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              void save({ azureEndpoint: endpoint.trim(), azureDeployment: deployment.trim() });
            }}
          >
            <SettingRow title={t("call.live.azureEndpoint")}>
              <input
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                aria-label={t("call.live.azureEndpoint")}
                value={endpoint}
                placeholder="https://my-resource.openai.azure.com"
                onChange={(event) => setEndpoint(event.target.value)}
                className={cn(textFieldCls, "w-56")}
              />
            </SettingRow>
            <SettingRow title={t("call.live.azureDeployment")} subtitle={t("call.live.azureHint")}>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                aria-label={t("call.live.azureDeployment")}
                value={deployment}
                placeholder="gpt-live-1"
                onChange={(event) => setDeployment(event.target.value)}
                className={cn(textFieldCls, "w-56")}
              />
            </SettingRow>
            {azureChanged && (
              <div className="flex justify-end px-2 py-1.5">
                <button type="submit" disabled={saving} className={rowPrimaryCls}>{t("common.save")}</button>
              </div>
            )}
          </form>
        )}
      </SettingsRows>
      {error && <p role="alert" className="m-0 px-3 text-[12px] leading-4 text-danger">{error}</p>}
    </div>
  );
}
