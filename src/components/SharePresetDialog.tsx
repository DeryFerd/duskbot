import { Check, Loader2, X } from "../icons";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { t, tFromServer } from "@/lib/i18n";
import { describePart, describeSkip, preparePictures, saveShareFile, type ShareSkip } from "@/lib/team-share";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { SettingRow, SettingsGroup, SettingsRows, SIMPLE_BUTTONS, SIMPLE_CARD, Switch } from "./SettingsPrimitives";
import { compactBackdropStyle, compactSheetStyle } from "./compact-settings-sheet";
import "../styles/settings.css";
import type { NewBotDefaults } from "../../shared/new-bot-defaults";
import type { PackageDocument, PackageSummary } from "../../shared/package-format";
import { friendlyError } from "@/lib/plain-error";

export interface PresetShareResponse {
  document: PackageDocument;
  filename: string;
  redacted: string[];
  skipped: ShareSkip[];
  summary: PackageSummary;
}

export interface PresetShareChoices {
  name: string;
  description?: string;
  release?: string;
  notes?: string;
  includeNotes: boolean;
  picture?: string;
  dryRun?: boolean;
}

export function presetShareBody(choices: PresetShareChoices): Record<string, unknown> {
  const text = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
  return {
    format: "package",
    version: 2,
    kind: "library",
    name: text(choices.name),
    presetName: text(choices.name),
    presetDescription: text(choices.description),
    release: text(choices.release),
    notes: text(choices.notes),
    includeMemory: choices.includeNotes,
    ...(choices.picture ? { presetAvatar: choices.picture } : {}),
    ...(choices.dryRun ? { dryRun: true } : {}),
  };
}

export function SharePresetContents({ preview, localSkips }: { preview: PresetShareResponse; localSkips: string[] }) {
  const preset = preview.document.package.presets?.[0];
  const notes = Object.keys(preset?.seed?.memory ?? {}).length;
  const rows: Array<[string, string]> = [
    [t("teamShare.part.skills"), preset?.skills?.length ? `${preset.skills.length} · ${preset.skills.join(", ")}` : "0"],
    [t("teamShare.part.notes"), notes ? String(notes) : t("teamShare.none")],
    [t("teamShare.part.pictures"), preset?.bot.appearance?.avatar ? t("teamShare.yes") : t("teamShare.none")],
  ];
  const skipped = [...localSkips, ...preview.skipped.map((skip) => describeSkip(skip, preview.document))];
  return (
    <>
      <SettingsGroup label={t("teamShare.included")} footnote={t("presetShare.never")}>
        <SettingsRows>
          {rows.map(([label, value]) => (
            <SettingRow key={label} title={label}>
              <span className="max-w-[300px] truncate text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary" title={value}>{value}</span>
            </SettingRow>
          ))}
        </SettingsRows>
      </SettingsGroup>
      {preview.redacted.length > 0 && (
        <SettingsGroup label={t("teamShare.redacted")}>
          <div className={cn(SIMPLE_CARD, "px-3 py-2.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary")}>
            <ul className="m-0 list-disc pl-5">
              {preview.redacted.map((part) => <li key={part}>{describePart(part, preview.document)}</li>)}
            </ul>
          </div>
        </SettingsGroup>
      )}
      {skipped.length > 0 && (
        <SettingsGroup label={t("teamShare.skipped")}>
          <div className={cn(SIMPLE_CARD, "px-3 py-2.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary")}>
            <ul className="m-0 list-disc pl-5">
              {skipped.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}
            </ul>
          </div>
        </SettingsGroup>
      )}
    </>
  );
}

export function SharePresetDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [release, setRelease] = useState("");
  const [notes, setNotes] = useState("");
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includePicture, setIncludePicture] = useState(true);
  const [picture, setPicture] = useState<{ dataUrl?: string; skipped: string[] } | null>(null);
  const [preview, setPreview] = useState<PresetShareResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<PresetShareResponse | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void api<{ defaults: NewBotDefaults }>("/api/bot-defaults")
      .then(async ({ defaults }) => {
        if (!cancelled && defaults.profile.name?.trim()) setName((current) => current || defaults.profile.name!.trim());
        const prepared = await preparePictures([{ id: "defaults", avatarUrl: defaults.profile.avatarUrl, avatarCrop: defaults.profile.avatarCrop }]);
        if (cancelled) return;
        setPicture({
          dataUrl: prepared.avatars.defaults,
          skipped: prepared.skipped.map((skip) => `${t("teamShare.field.picture")} (${tFromServer(`teamShare.skip.${skip.reason}`, skip.reason)})`),
        });
      })
      .catch(() => { if (!cancelled) setPicture({ skipped: [] }); });
    return () => { cancelled = true; };
  }, []);

  const choices = (dryRun: boolean): PresetShareChoices => ({
    name, description, release, notes, includeNotes, dryRun,
    ...(includePicture && picture?.dataUrl ? { picture: picture.dataUrl } : {}),
  });

  useEffect(() => {
    if (!picture) return;
    const id = ++request.current;
    const timer = window.setTimeout(() => {
      api<PresetShareResponse>("/api/teams/export", { method: "POST", body: JSON.stringify(presetShareBody({ ...choices(true), release: undefined })) })
        .then((result) => {
          if (id !== request.current) return;
          setPreview(result);
          setError("");
          setRelease((current) => current || result.document.package.release);
        })
        .catch((cause) => {
          if (id !== request.current) return;
          setPreview(null);
          setError(friendlyError(cause));
        });
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picture, includeNotes, includePicture]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<PresetShareResponse>("/api/teams/export", { method: "POST", body: JSON.stringify(presetShareBody(choices(false))) });
      saveShareFile(result.filename, result.document);
      setSaved(result);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  const localSkips = includePicture ? picture?.skipped ?? [] : [];
  const field = "h-[30px] w-[220px] max-w-full rounded-lg border border-transparent bg-transparent px-2 text-[13px] leading-[18px] tracking-[0.015em] text-ink outline-none placeholder:text-ink-secondary";
  return createPortal(
    <div data-settings-sheet data-settings-look="simple" className="settings-scrim z-[80]" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <div aria-hidden="true" className="settings-backdrop" style={compactBackdropStyle} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="share-preset-title" tabIndex={-1}
        className="settings-dialog" style={compactSheetStyle(520)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) { event.stopPropagation(); onClose(); }
          if (event.key === "Tab") {
            const controls = dialogRef.current?.querySelectorAll<HTMLElement>("input:enabled, textarea:enabled, button:enabled");
            if (!controls?.length) return;
            const first = controls[0]!, last = controls[controls.length - 1]!;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <section className="settings-panel min-h-0">
          <button type="button" aria-label={t("presetShare.close")} disabled={saving} onClick={onClose} className="settings-close disabled:opacity-50"><X size={14} /></button>
          <div className="settings-pane-header">
            <h2 id="share-preset-title" className="settings-pane-title">{t("presetShare.title")}</h2>
          </div>
          <div className="settings-scroll">
            <div className={cn("settings-pane", SIMPLE_BUTTONS)} style={{ gap: 24, paddingBottom: 12 }}>
              {saved ? (
                <>
                  <div className="flex flex-col gap-0.5 px-2.5">
                    <p className="m-0 flex items-center gap-1.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink"><Check size={14} className="shrink-0 text-success" />{t("teamShare.saved", { filename: saved.filename })}</p>
                    <p className="m-0 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{t("presetShare.savedHint")}</p>
                  </div>
                  <SharePresetContents preview={saved} localSkips={localSkips} />
                </>
              ) : (
                <>
                  <p className="m-0 px-2.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary text-pretty">{t("presetShare.intro")}</p>
                  {preview
                    ? <SharePresetContents preview={preview} localSkips={localSkips} />
                    : !error && <div className="flex items-center gap-2 px-2.5 py-3 text-[13px] leading-[18px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("presetShare.preparing")}</div>}
                  <fieldset className="m-0 border-0 p-0" disabled={saving}>
                    <SettingsRows>
                      <SettingRow title={t("presetShare.includePicture")}>
                        <Switch checked={includePicture} aria-label={t("presetShare.includePicture")} onClick={() => setIncludePicture((value) => !value)} />
                      </SettingRow>
                      <SettingRow title={t("presetShare.includeNotes")}>
                        <Switch checked={includeNotes} aria-label={t("presetShare.includeNotes")} onClick={() => setIncludeNotes((value) => !value)} />
                      </SettingRow>
                    </SettingsRows>
                  </fieldset>
                  <fieldset className="m-0 border-0 p-0" disabled={saving}>
                    <SettingsRows>
                      <SettingRow title={t("presetShare.name")}>
                        <input value={name} maxLength={100} disabled={saving} aria-label={t("presetShare.name")} onChange={(event) => setName(event.target.value)} className={field} />
                      </SettingRow>
                      <SettingRow title={t("teamShare.release")}>
                        <input value={release} maxLength={20} disabled={saving} aria-label={t("teamShare.release")} placeholder="1.0.0" onChange={(event) => setRelease(event.target.value)} className={field} />
                      </SettingRow>
                      <SettingRow title={t("presetShare.description")}>
                        <input value={description} maxLength={300} disabled={saving} aria-label={t("presetShare.description")} onChange={(event) => setDescription(event.target.value)} className={field} />
                      </SettingRow>
                      <SettingRow title={t("teamShare.notes")}>
                        <textarea value={notes} maxLength={4000} rows={2} disabled={saving} aria-label={t("teamShare.notes")} onChange={(event) => setNotes(event.target.value)} className={cn(field, "h-auto resize-none py-1.5")} />
                      </SettingRow>
                    </SettingsRows>
                  </fieldset>
                </>
              )}
            </div>
          </div>
          {error && <p role="alert" className="m-0 px-6 pb-2 text-[13px] leading-[18px] text-danger">{error}</p>}
          <div className={cn("flex shrink-0 items-center justify-end gap-2 px-6 pb-5 pt-1", SIMPLE_BUTTONS)}>
            {saved ? (
              <button type="button" onClick={onClose} className="ui-button ui-button-primary">{t("teamShare.done")}</button>
            ) : (
              <>
                <button type="button" disabled={saving} onClick={onClose} className="ui-button">{t("common.cancel")}</button>
                <button type="button" disabled={saving || !preview} onClick={() => void save()} className="ui-button ui-button-primary">
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {saving ? t("teamShare.saving") : t("teamShare.save")}
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
