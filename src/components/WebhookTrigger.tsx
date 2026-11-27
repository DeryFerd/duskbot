// The editor for an automation that runs when another app sends something: who does it and what it does, with the
// rest under More. The words a person sees never say webhook, endpoint or payload.
import { ModalLayer } from "./ui/ModalLayer";
import { useRef, useState } from "react";
import { Cloud, Laptop, Loader2 } from "../icons";

import { BotAvatar } from "@/components/Avatar";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { computerCapableEngine } from "@/lib/remote-desktop";
import type { RoutineRunOn } from "@/lib/routines";
import { WEBHOOK_DEFAULT_MAX_PENDING_RUNS, WEBHOOK_MAX_PENDING_RUNS_LIMIT, webhookActivationDefaults, webhookMaxPendingRunsInput, type WebhookCredential, type WebhookTrigger, type WebhookTriggerInput } from "@/lib/webhooks";
import { api, useStore, type Bot } from "@/state/store";
import { Icon } from "./Icon";
import { fieldLabelCls, formBodyCls, formCloseCls, formFooterCls, formHeaderCls, formSheetCls, formTitleCls, rowButtonCls, rowPrimaryCls, textAreaCls, textFieldCls } from "./ui/GrokDialog";
import { friendlyError } from "@/lib/plain-error";

/** A name when the person gives none: the instructions' first words, or the bot's. */
export function suggestedName(prompt: string, bot?: Bot) {
  const first = prompt.trim().split(/[.!?\n]/)[0]?.trim().slice(0, 60);
  return first || `${bot?.name ?? "Bot"} automation`;
}

const FIELD = textFieldCls;

export function WebhookEditor({ webhook, bots, initialBotId, onClose, onCredential }: { webhook?: WebhookTrigger; bots: Bot[]; initialBotId?: string; onClose: () => void; onCredential: (credential: WebhookCredential, webhookId: string) => void }) {
  const { state, dispatch } = useStore();
  const [botId, setBotId] = useState(webhook?.botId ?? (initialBotId && bots.some((bot) => bot.id === initialBotId) ? initialBotId : bots[0]?.id) ?? "");
  const [name, setName] = useState(webhook?.name ?? "");
  const [prompt, setPrompt] = useState(webhook?.prompt ?? "");
  const [runOn, setRunOn] = useState<RoutineRunOn>(webhook?.runOn ?? "maus");
  const [eventTypes, setEventTypes] = useState((webhook?.eventTypes ?? []).join(", "));
  const [maxPendingRuns, setMaxPendingRuns] = useState(webhook?.maxPendingRuns?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);
  const cloudReady = Boolean(state.config?.vps?.configured && computerCapableEngine(state.instances, bots.find((bot) => bot.id === botId)?.modelSelection.instanceId)?.snapshot.state === "available");

  const save = async () => {
    const bot = bots.find((candidate) => candidate.id === botId);
    const pendingLimit = webhookMaxPendingRunsInput(maxPendingRuns);
    if (pendingLimit === undefined) {
      setError(t("automations.editor.app.limitError", { max: WEBHOOK_MAX_PENDING_RUNS_LIMIT }));
      return;
    }
    const input: WebhookTriggerInput = { name: name.trim() || suggestedName(prompt, bot), prompt: prompt.trim(), botId, runOn, ...webhookActivationDefaults(webhook), eventTypes: eventTypes.split(",").map((value) => value.trim()).filter(Boolean), maxPendingRuns: pendingLimit };
    setSaving(true);
    setError("");
    try {
      const response = await api(webhook ? `/api/webhooks/${webhook.id}` : "/api/webhooks", { method: webhook ? "PATCH" : "POST", body: JSON.stringify(input) });
      dispatch({ type: "webhookPatched", webhook: response.webhook });
      onClose();
      if (response.credential) onCredential(response.credential, response.webhook.id);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalLayer><div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden="true" className="ui-dialog-scrim absolute inset-0" onMouseDown={onClose} />
      <div ref={dialogRef} role="dialog" aria-modal="true" data-settings-look="simple" aria-label={webhook ? t("automations.editor.app.editTitle") : t("automations.editor.app.title")} tabIndex={-1} style={{ maxWidth: "min(460px, calc(100vw - 32px))" }} className={formSheetCls}>
        <div className={formHeaderCls}>
          <div className="min-w-0 flex-1">
            <h2 className={formTitleCls}>{webhook ? t("automations.editor.app.editTitle") : t("automations.editor.app.title")}</h2>
            </div>
          <button type="button" onClick={onClose} aria-label={t("automations.newBox.cancel")} className={formCloseCls}><Icon name="close" size={16} /></button>
        </div>
        <div className={cn(formBodyCls, "space-y-4")}>
          <div>
            <div className={cn(fieldLabelCls, "mb-1")}>{t("automations.editor.app.who")}</div>
            <div className="grid grid-cols-2 gap-0.5 rounded-[10px] border border-transparent p-1 sm:grid-cols-3">{bots.map((bot) => (
              <button key={bot.id} type="button" onClick={() => setBotId(bot.id)} aria-pressed={botId === bot.id} className={cn("flex h-8 min-w-0 items-center gap-2 rounded-[8px] px-2 text-left transition-[background-color] duration-[120ms] ease-[ease] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus", botId === bot.id ? "bg-ink/6" : "hover:bg-ink/5")}>
                <BotAvatar bot={bot} state={botId === bot.id ? "happy" : "idle"} size={20} animated={false} /><span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-ink">{bot.name}</span>
              </button>
            ))}</div>
          </div>
          <label className="block">
            <span className={cn(fieldLabelCls, "mb-1 block")}>{t("automations.editor.app.what")}</span>
            <textarea autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder={t("automations.editor.app.whatPlaceholder")} className={cn(textAreaCls, "resize-y")} />
          </label>
          <details>
            <summary className="-ml-1 w-fit cursor-pointer rounded-[6px] px-1 text-[13px] leading-[18px] text-ink/68 transition-[background-color,color] duration-[120ms] ease-[ease] hover:bg-ink/6 hover:text-ink">{t("automations.more")}</summary>
            <div className="mt-4 space-y-4">
              <label className="block"><span className={cn(fieldLabelCls, "mb-1 block")}>{t("automations.editor.app.name")}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={suggestedName(prompt, bots.find((bot) => bot.id === botId))} className={FIELD} /></label>
              <div>
                <div className={cn(fieldLabelCls, "mb-1")}>{t("automations.editor.app.runOn")}</div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setRunOn("maus")} className={cn("flex h-8 items-center gap-2 rounded-[10px] border px-2.5 text-left text-[13px] text-ink", runOn === "maus" ? "border-transparent bg-ink/4" : "border-transparent hover:bg-ink/4")}><Laptop size={14} />{t("automations.editor.app.thisComputer")}</button>
                  <button type="button" disabled={!cloudReady && runOn !== "cloud"} onClick={() => setRunOn("cloud")} className={cn("flex h-8 items-center gap-2 rounded-[10px] border px-2.5 text-left text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-45", runOn === "cloud" ? "border-transparent bg-ink/4" : "border-transparent hover:bg-ink/4")}><Cloud size={14} />{t("automations.editor.app.cloud")}</button>
                </div>
              </div>
              <label className="block"><span className={cn(fieldLabelCls, "mb-1 block")}>{t("automations.editor.app.events")}</span><input value={eventTypes} onChange={(event) => setEventTypes(event.target.value)} placeholder="push, workflow_run" className={FIELD} /><span className="mt-1 block text-[12px] leading-4 text-ink/56">{t("automations.editor.app.eventsHelp")}</span></label>
              <label className="block"><span className={cn(fieldLabelCls, "mb-1 block")}>{t("automations.editor.app.limit")}</span><input type="number" inputMode="numeric" min={1} max={WEBHOOK_MAX_PENDING_RUNS_LIMIT} step={1} value={maxPendingRuns} onChange={(event) => setMaxPendingRuns(event.target.value)} placeholder={String(WEBHOOK_DEFAULT_MAX_PENDING_RUNS)} className={FIELD} /><span className="mt-1 block text-[12px] leading-4 text-ink/56">{t("automations.editor.app.limitHelp", { count: WEBHOOK_DEFAULT_MAX_PENDING_RUNS })}</span></label>
            </div>
          </details>
          {error && <p role="alert" className="m-0 text-[12px] leading-4 text-danger">{error}</p>}
        </div>
        <div className={formFooterCls}>
          <button type="button" onClick={onClose} className={rowButtonCls}>{t("automations.newBox.cancel")}</button>
          <button type="button" disabled={saving || !botId} onClick={() => void save()} className={cn(rowPrimaryCls, "gap-1.5")}>{saving && <Loader2 size={14} className="animate-spin" />}{webhook ? t("automations.editor.app.save") : t("automations.editor.app.create")}</button>
        </div>
      </div>
    </div></ModalLayer>
  );
}
