// Security: the harness holds the cloud provider keys; the renderer never talks to ElevenLabs or Fish Audio itself.
import { useEffect, useRef, useState } from "react";
import { Loader2, Volume2 } from "../icons";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import {
  listLocalSystemVoices,
  localSystemVoicesAvailable,
  remoteSystemVoice,
  remoteVoiceProvider,
  setRemoteSystemVoice,
  setRemoteVoiceProvider,
  type RemoteVoiceProvider,
} from "@/lib/local-voice";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { voiceKeyDraftValue, type VoiceKeyDraft } from "@/lib/voice-key-draft";
import { VoicePicker, type PickerVoice } from "./VoicePicker";
import { SettingRow, SettingsGroup, SettingsRows, SIMPLE_BUTTONS, Switch } from "./SettingsPrimitives";
import { SettingsSelect } from "./SettingsSelect";
import { KeysLink } from "./keys/KeysLink";
import { friendlyError } from "@/lib/plain-error";

const FIELD = "h-[30px] w-[150px] min-w-0 rounded-lg border-0 bg-ink/[0.06] px-2.5 text-[13px] leading-[18px] text-ink outline-none placeholder:text-ink-tertiary hover:bg-ink/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";
const SAMPLE = "Morning. Overnight the tests went green, and I left two notes for you in the thread.";
const FISH_MODELS = [
  { value: "s2.1-pro", label: "voice.fish.modelPro" },
  { value: "s2.1-pro-free", label: "voice.fish.modelFree" },
] as const;
type FishModel = (typeof FISH_MODELS)[number]["value"];
type ProviderChoice = NonNullable<NonNullable<ConfigStatus["tts"]>["provider"]>;
const PROVIDERS: ReadonlyArray<{ value: Exclude<ProviderChoice, "system">; label: () => string }> = [
  { value: "elevenlabs", label: () => t("voice.elevenlabs.label") },
  { value: "fish", label: () => t("voice.fish.label") },
  { value: "xai", label: () => t("voice.grok.label") },
  { value: "gemini", label: () => "Gemini" },
  { value: "openai", label: () => "OpenAI" },
  { value: "deepgram", label: () => "Deepgram" },
  { value: "cartesia", label: () => "Cartesia" },
  { value: "chatterbox", label: () => t("voice.chatterboxLocal") },
];

export function VoiceSettings({
  bot,
  onPatch,
  workspaceConfigurationLocked = false,
}: {
  bot: Bot;
  onPatch: (patch: Partial<Pick<Bot, "voice" | "speakReplies" | "voiceNotes">>) => void;
  workspaceConfigurationLocked?: boolean;
}) {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;

  const [keyDraft, setKeyDraft] = useState<VoiceKeyDraft>({ provider: null, value: "" });
  const [serverUrl, setServerUrl] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [savingFishModel, setSavingFishModel] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [addingVoice, setAddingVoice] = useState<PickerVoice | null>(null);
  const addGeneration = useRef(0);
  const [addError, setAddError] = useState<string | null>(null);
  const [voiceQuery, setVoiceQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");

  const { capabilities } = useDesktopCapabilities();
  const speech = useSpeech();
  const preparingSample = speech.status === "preparing" && speech.botId === bot.id && !speech.messageId;
  const localMacClient = workspaceConfigurationLocked && localSystemVoicesAvailable();
  const [deviceProvider, setDeviceProvider] = useState<RemoteVoiceProvider>(() => remoteVoiceProvider());
  const [deviceVoice, setDeviceVoice] = useState(() => remoteSystemVoice(bot.id));
  const usesLocalSystem = localMacClient && deviceProvider === "system";
  const systemVoicesAvailable = capabilities.host.platform === "darwin";
  const provider = tts?.provider ?? (systemVoicesAvailable ? "system" : "elevenlabs");
  const fixedVoices = provider === "gemini" || provider === "openai" || provider === "deepgram";
  const searchable = (provider === "fish" || provider === "elevenlabs" || provider === "cartesia" || fixedVoices) && !usesLocalSystem;
  const voiceSearch = searchable && !fixedVoices ? searchedQuery : "";
  const pickedVoice = searchable && !fixedVoices ? (bot.voice ?? "") : "";
  const cloudProvider = provider === "deepgram"
    ? { id: "deepgram" as const, name: "Deepgram", credential: "deepgramKey" as const, configField: "deepgramKey" as const,
        placeholder: t("voice.deepgram.keyPlaceholder"), keyUrl: "https://console.deepgram.com/" }
    : provider === "cartesia"
    ? { id: "cartesia" as const, name: "Cartesia", credential: "cartesiaKey" as const, configField: "cartesiaKey" as const,
        placeholder: t("voice.cartesia.keyPlaceholder"), keyUrl: "https://play.cartesia.ai/keys" }
    : provider === "gemini"
    ? { id: "gemini" as const, name: "Gemini", credential: "geminiTtsKey" as const, configField: "geminiKey" as const,
        placeholder: t("voice.gemini.keyPlaceholder"), keyUrl: "https://aistudio.google.com/api-keys" }
    : provider === "fish"
    ? {
        id: "fish" as const,
        name: "Fish Audio",
        credential: "fishAudioKey" as const,
        configField: "fishKey" as const,
        placeholder: t("voice.fish.keyPlaceholder"),
        keyUrl: "https://fish.audio/app/api-keys/",
      }
    : provider === "elevenlabs"
      ? {
          id: "elevenlabs" as const,
          name: "ElevenLabs",
          credential: "ttsKey" as const,
          configField: "key" as const,
          placeholder: t("voice.elevenlabs.keyPlaceholder"),
          keyUrl: "https://elevenlabs.io/app/settings/api-keys",
        }
      : null;
  
  const key = cloudProvider ? voiceKeyDraftValue(keyDraft, cloudProvider.id) : "";
  const hostProviderLabel = provider === "gemini" || provider === "openai" || provider === "deepgram" || provider === "cartesia"
    ? t("voice.hostLabel", { provider: provider === "gemini" ? "Gemini" : provider === "openai" ? "OpenAI" : cloudProvider?.name ?? "" }) : provider === "fish"
    ? t("voice.hostLabel", { provider: t("voice.fish.label") })
    : provider === "elevenlabs"
      ? t("voice.hostLabel", { provider: t("voice.elevenlabs.label") })
      : provider === "chatterbox"
        ? t("voice.hostLabel", { provider: t("voice.chatterboxLabel") })
        : provider === "xai" ? t("voice.grok.host") : t("voice.host");
  const hostConfigured = Boolean(tts?.configured);
  const included = Boolean(tts?.included);
  const configured = usesLocalSystem || hostConfigured;

  useEffect(() => {
    setDeviceVoice(remoteSystemVoice(bot.id));
  }, [bot.id]);

  const sampleVoice = usesLocalSystem ? deviceVoice : bot.voice;
  useEffect(() => () => {
    const playing = speaker.state;
    if (playing.status !== "idle" && playing.botId === bot.id && !playing.messageId) speaker.stop();
  }, [bot.id, sampleVoice, provider]);

  useEffect(() => {
    const timer = setTimeout(() => setSearchedQuery(voiceQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [voiceQuery]);

  useEffect(() => setVoiceQuery(""), [provider]);

  useEffect(() => {
    setServerUrl(tts?.baseUrl ?? "");
    setModel(tts?.model ?? "");
  }, [tts?.baseUrl, tts?.model]);

  // Security: discard the draft on every provider change, and keep it tagged, so one provider's credential never goes
  // to another service.
  useEffect(() => {
    setKeyDraft({ provider: null, value: "" });
  }, [provider]);

  useEffect(() => setVoices([]), [provider, usesLocalSystem]);

  useEffect(() => {
    setListError(null);
    if (usesLocalSystem) {
      const load = () => setVoices(listLocalSystemVoices());
      load();
      window.speechSynthesis.addEventListener("voiceschanged", load);
      return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
    }
    if (!hostConfigured) {
      setVoices([]);
      return;
    }
    let alive = true;
    setLoadingVoices(true);
    const params = new URLSearchParams();
    if (voiceSearch) params.set("q", voiceSearch);
    if (provider === "fish" && pickedVoice) params.set("current", pickedVoice);
    const query = params.toString();
    api(`/api/tts/voices${query ? `?${query}` : ""}`)
      .then((r: { voices?: typeof voices; error?: string }) => {
        if (!alive) return;
        setListError(null);
        setVoices(r.voices ?? []);
        if (r.error) setError(r.error);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setVoices([]);
        setListError(friendlyError(e, t("voice.listFailed")));
      })
      .finally(() => alive && setLoadingVoices(false));
    return () => {
      alive = false;
    };
  }, [hostConfigured, provider, usesLocalSystem, voiceSearch, pickedVoice]);

  const chooseDeviceProvider = (next: RemoteVoiceProvider) => {
    setRemoteVoiceProvider(next);
    setDeviceProvider(next);
    setError(null);
  };

  const chooseVoice = (voiceId: string) => {
    if (usesLocalSystem) {
      setRemoteSystemVoice(bot.id, voiceId);
      setDeviceVoice(voiceId);
      return;
    }
    onPatch({ voice: voiceId });
  };

  // An add that settles after the bot or the provider changed belongs to neither: it must not set this voice.
  useEffect(() => {
    addGeneration.current += 1;
    setAddingVoice(null);
    setAddError(null);
  }, [bot.id, provider]);

  const pickVoice = (voice: PickerVoice) => {
    setAddError(null);
    if (!voice.publicOwnerId) return chooseVoice(voice.id);
    const generation = ++addGeneration.current;
    const current = () => generation === addGeneration.current;
    setAddingVoice(voice);
    api("/api/tts/voices/add", {
      method: "POST",
      body: JSON.stringify({ publicOwnerId: voice.publicOwnerId, voiceId: voice.id, name: voice.label }),
    })
      .then((r: { voiceId: string }) => current() && chooseVoice(r.voiceId))
      .catch((e: unknown) => current() && setAddError(friendlyError(e)))
      .finally(() => current() && setAddingVoice(null));
  };

  const setProvider = (next: ProviderChoice) => {
    if (next === provider || switching || (next === "system" && !systemVoicesAvailable)) return;
    setSwitching(true);
    setKeyDraft({ provider: null, value: "" });
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { provider: next } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setSwitching(false));
  };

  const saveKey = () => {
    const nextKey = key.trim();
    if (!nextKey || !cloudProvider || keyDraft.provider !== cloudProvider.id) return Promise.resolve();
    setSaving(true);
    setError(null);
    const request = window.duskDesktop?.setCredential
      ? window.duskDesktop.setCredential(cloudProvider.credential, nextKey)
      : api("/api/config", {
          method: "PUT",
          body: JSON.stringify({ tts: { [cloudProvider.configField]: nextKey } }),
        });
    return request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKeyDraft({ provider: null, value: "" });
      })
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setSaving(false));
  };

  const saveServer = () => {
    const next = serverUrl.trim();
    if (!next || savingServer) return Promise.resolve();
    if (!/^https?:\/\//i.test(next)) {
      setError(t("voice.serverAddressError"));
      return Promise.resolve();
    }
    setSavingServer(true);
    setError(null);
    return api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { baseUrl: next, model: model.trim() } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setSavingServer(false));
  };

  const saveFishModel = (next: FishModel) => {
    if (next === tts?.fishModel || savingFishModel) return;
    setSavingFishModel(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { fishModel: next } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setSavingFishModel(false));
  };

  if (!tts) return null;

  const selectedVoice = usesLocalSystem ? deviceVoice : (bot.voice ?? "");
  const ready = usesLocalSystem || (hostConfigured && (provider === "system" || Boolean(selectedVoice || tts.voice)));
  const selectedDescription = voices.find((voice) => voice.id === selectedVoice)?.description;
  const providerOptions = [
    ...(systemVoicesAvailable ? [{ value: "system", label: t("voice.macBuiltIn") }] : []),
    ...PROVIDERS.map((option) => ({ value: option.value, label: option.label() })),
  ];
  const voiceHint = selectedDescription && !searchable ? selectedDescription : t("voice.description");
  const saveLabel = (busy: boolean) => (busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("common.save"));

  return (
    <div data-settings-look="simple" className={cn("flex flex-col gap-7", SIMPLE_BUTTONS)}>
      <SettingsGroup>
        <SettingsRows>
          {localMacClient && (
            <SettingRow title={t("voice.macOutput")} subtitle={t("voice.macChoice")}>
              <SettingsSelect
                variant="segmented"
                value={deviceProvider}
                aria-label={t("voice.macOutput")}
                onChange={(e) => chooseDeviceProvider(e.target.value as RemoteVoiceProvider)}
                options={[
                  { value: "system", label: t("voice.macBuiltIn") },
                  { value: "host", label: hostProviderLabel, disabled: !hostConfigured },
                ]}
              />
            </SettingRow>
          )}

          {!workspaceConfigurationLocked && (
            <SettingRow
              title={t("voice.engine")}
              subtitle={provider === "system" ? t("voice.nativeHint") : undefined}
            >
              <SettingsSelect
                value={provider}
                disabled={switching}
                onChange={(e) => setProvider(e.target.value as ProviderChoice)}
                aria-label={t("voice.engine")}
                options={providerOptions}
              />
            </SettingRow>
          )}

          {!workspaceConfigurationLocked && cloudProvider && (
              <SettingRow
                title={t("voice.providerKey", { provider: cloudProvider.name })}
                subtitle={configured
                  ? (included ? t("keys.includedWithCloudPro") : t("voice.connected"))
                  : (
                    <a href={cloudProvider.keyUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                      {t("voice.getKey", { provider: cloudProvider.name })}
                    </a>
                  )}
              >
                {!included && (
                  <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void saveKey(); }}>
                    <input
                      type="password"
                      value={key}
                      onChange={(e) => setKeyDraft({ provider: cloudProvider.id, value: e.target.value })}
                      placeholder={configured && !included ? "••••••••  (paste to replace)" : cloudProvider.placeholder}
                      aria-label={`${cloudProvider.name} key`}
                      autoComplete="off"
                      className={FIELD}
                    />
                    <button type="submit" className="ui-button" disabled={saving || !key.trim()}>{saveLabel(saving)}</button>
                  </form>
                )}
              </SettingRow>
          )}

          {!workspaceConfigurationLocked && provider === "fish" && (
            <SettingRow title={t("voice.fish.model")} subtitle={t("voice.fish.modelHint")}>
              <SettingsSelect
                value={tts.fishModel ?? "s2.1-pro"}
                onChange={(e) => saveFishModel(e.target.value as FishModel)}
                disabled={savingFishModel}
                aria-label={t("voice.fish.model")}
                options={FISH_MODELS.map((option) => ({ value: option.value, label: t(option.label) }))}
              />
            </SettingRow>
          )}

          {provider === "xai" && (
            <SettingRow
              title={t("voice.providerKey", { provider: "Grok" })}
              subtitle={hostConfigured ? t("voice.grok.ready") : <>{t("voice.grok.missingKey")} <KeysLink id="xai" /></>}
            >{null}</SettingRow>
          )}

          {provider === "openai" && (
            <SettingRow
              title={t("voice.providerKey", { provider: "OpenAI" })}
              subtitle={hostConfigured ? t("voice.openai.ready") : <>{t("voice.openai.missingKey")} <KeysLink id="openai" /></>}
            >{null}</SettingRow>
          )}

          {!workspaceConfigurationLocked && provider === "chatterbox" && (
            <>
              <SettingRow title={t("voice.chatterboxServer")} subtitle={configured ? t("common.saved") : undefined}>
                <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void saveServer(); }}>
                  <input
                    type="url"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    placeholder="http://127.0.0.1:4123"
                    aria-label={t("voice.chatterboxAddress")}
                    autoComplete="off"
                    spellCheck={false}
                    className={FIELD}
                  />
                  <button type="submit" className="ui-button" disabled={savingServer || !serverUrl.trim()}>{saveLabel(savingServer)}</button>
                </form>
              </SettingRow>
              <SettingRow
                title={t("voice.chatterboxModel")}
                subtitle={<>
                  {t("voice.chatterboxHelp")}{" "}
                  <a href="https://github.com/resemble-ai/chatterbox" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                    {t("voice.chatterboxHowTo")}
                  </a>
                </>}
              >
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void saveServer()}
                  placeholder={t("voice.chatterboxModelPlaceholder")}
                  aria-label={t("voice.chatterboxModel")}
                  autoComplete="off"
                  spellCheck={false}
                  className={FIELD}
                />
              </SettingRow>
            </>
          )}

          {!workspaceConfigurationLocked && provider === "gemini" && (
            <SettingRow title={t("voice.gemini.model")}>
              <SettingsSelect
                value={tts.model || "gemini-3.8-flash-lite-tts"}
                aria-label={t("voice.gemini.model")}
                options={[
                  { value: "gemini-3.8-flash-lite-tts", label: "Gemini 3.8 Flash-Lite TTS" },
                  { value: "gemini-3.8-flash-tts", label: "Gemini 3.8 Flash TTS" },
                ]}
                onChange={(event) => {
                  void api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { model: event.target.value } }) })
                    .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
                    .catch((error: unknown) => setError(friendlyError(error)));
                }}
              />
            </SettingRow>
          )}

          {configured && (
            <SettingRow
              title={t("voice.title")}
              subtitle={voiceHint}
              message={(listError || addError) && <div role="alert" className="text-danger">{listError ?? addError}</div>}
            >
              <div className="flex items-center gap-2">
                {searchable ? (
                  <VoicePicker
                    key={provider}
                    value={selectedVoice}
                    voices={fixedVoices ? voices.filter((voice) => voice.label.toLowerCase().includes(voiceQuery.trim().toLowerCase())) : voices}
                    loading={loadingVoices || (!fixedVoices && voiceQuery.trim() !== searchedQuery)}
                    query={voiceQuery}
                    onQuery={setVoiceQuery}
                    onPick={pickVoice}
                    pending={addingVoice ?? undefined}
                    defaultLabel={tts.voice ? t("voice.installDefault") : t("voice.pick")}
                    ariaLabel={`${bot.name}'s voice`}
                  />
                ) : (
                  <SettingsSelect
                    value={selectedVoice}
                    onChange={(e) => chooseVoice(e.target.value)}
                    aria-label={`${bot.name}'s voice`}
                    data-settings-select="voice"
                    options={[
                      {
                        value: "",
                        label: loadingVoices
                          ? t("voice.loading")
                          : usesLocalSystem || provider === "system"
                            ? t("voice.macDefault")
                            : tts.voice ? t("voice.installDefault") : t("voice.pick"),
                      },
                      ...(selectedVoice && !voices.some((voice) => voice.id === selectedVoice)
                        ? [{ value: selectedVoice, label: t("voice.current") }]
                        : []),
                      ...voices.map((v) => ({ value: v.id, label: v.label })),
                    ]}
                  />
                )}
                <button
                  type="button"
                  onClick={() => void speaker.speak(SAMPLE, { voiceId: bot.voice, botId: bot.id })}
                  disabled={!ready || preparingSample}
                  aria-busy={preparingSample}
                  title={ready ? t("voice.hear") : t("voice.pickFirst")}
                  aria-label={t("voice.hear")}
                  className="ui-button"
                >
                  {preparingSample ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
                  {t("voice.try")}
                </button>
              </div>
            </SettingRow>
          )}
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRows>
          <SettingRow title={t("voice.readReplies")} subtitle={t("voice.readRepliesHelp")}>
            <Switch
              checked={Boolean(bot.speakReplies)}
              aria-label={t("voice.readReplies")}
              onClick={() => onPatch({ speakReplies: !bot.speakReplies })}
            />
          </SettingRow>
          <SettingRow title={t("voice.notes")} subtitle={t("voice.notesHelp")}>
            <Switch
              checked={bot.voiceNotes !== false}
              aria-label={t("voice.notes")}
              onClick={() => onPatch({ voiceNotes: bot.voiceNotes === false })}
            />
          </SettingRow>
        </SettingsRows>
        {error && <div role="alert" className="px-3 text-[12px] leading-4 text-danger">{error}</div>}
      </SettingsGroup>
    </div>
  );
}
