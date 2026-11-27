import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Trash2, X } from "../icons";

import { activeLocale, t } from "@/lib/i18n";
import { api, openBot, useStore, type Bot } from "@/state/store";

import { BotAvatar } from "./Avatar";
import { archivableChief } from "./bot-archive";
import { ConfirmDialog } from "./ConfirmDialog";
import { PixelIcon } from "./ui/PixelIcon";
import { cn } from "@/lib/cn";
import { SIMPLE_BUTTONS, SIMPLE_CARD, SettingsGroup } from "./SettingsPrimitives";
import { compactBackdropStyle, compactSheetStyle } from "./compact-settings-sheet";
import "../styles/settings.css";
import { friendlyError } from "@/lib/plain-error";

const dangerPillCls = "ui-button text-danger! enabled:hover:bg-danger/10!";

export type BotConfirmKind = "archive" | "delete";

/** `chief`: deleting a Chief of Staff, whose chats hold the team's whole setup, which archiving it would keep. */
export function botConfirmCopy(kind: BotConfirmKind, name: string, chief = false) {
  return kind === "archive"
    ? {
        title: t("sidebar.confirm.archiveTitle", { name }),
        body: t("confirm.botArchive"),
        confirmLabel: t("sidebar.bot.archive"),
        tone: "neutral" as const,
        art: <PixelIcon name="parcel" size={28} />,
      }
    : {
        title: t("sidebar.confirm.deleteTitle", { name }),
        // a Chief's own line suggests archiving; it still says what deleting takes with it
        body: chief ? `${t("confirm.botDeleteChief")} ${t("confirm.botDelete")}` : t("confirm.botDelete"),
        confirmLabel: t("common.delete"),
        tone: "danger" as const,
        art: <PixelIcon name="alert" size={28} />,
      };
}

/** The dialog that asks before a bot is archived or deleted; deleting a Chief of Staff offers to archive it instead. */
export function botConfirmProps(confirm: { kind: BotConfirmKind; bot: Bot } | null, bots: readonly Bot[], act: {
  archive: (bot: Bot) => void;
  remove: (bot: Bot) => void;
  archiveInstead: (chief: Bot) => void;
}) {
  const chief = confirm?.kind === "delete" ? archivableChief(bots, confirm.bot.id) : undefined;
  return {
    open: confirm !== null,
    ...(confirm ? botConfirmCopy(confirm.kind, confirm.bot.name, Boolean(chief)) : botConfirmCopy("archive", "")),
    alternative: chief ? { label: t("sidebar.confirm.archiveInstead"), onClick: () => act.archiveInstead(chief) } : undefined,
    onConfirm: () => {
      if (!confirm) return;
      if (confirm.kind === "archive") act.archive(confirm.bot);
      else act.remove(confirm.bot);
    },
  };
}

export function archivedDeleteAllCopy() {
  return {
    title: t("sidebar.archived.deleteAllTitle"),
    body: t("confirm.archivedDeleteAll"),
    confirmLabel: t("sidebar.archived.deleteAll"),
    tone: "danger" as const,
  };
}

export function ArchivedBotRow({
  bot,
  restoring,
  deleting,
  disabled,
  onRestore,
  onDelete,
}: {
  bot: Bot;
  restoring: boolean;
  deleting: boolean;
  disabled: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-1.5">
      <BotAvatar bot={bot} state="happy" size={32} animated={false} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="truncate text-[13px] leading-[18px] tracking-[0.015em] text-ink">{bot.name}</div>
        <div className="truncate text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{bot.title || t("sidebar.archived.botFallback")}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={onRestore} disabled={disabled || deleting} className="ui-button">
          {restoring && <Loader2 size={12} className="animate-spin" />}
          {t("sidebar.archived.restore")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled || deleting}
          aria-label={t("sidebar.archived.deleteAria", { name: bot.name })}
          className={dangerPillCls}
        >
          {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          {t("common.delete")}
        </button>
      </div>
    </div>
  );
}

function keepTabInside(event: KeyboardEvent, root: HTMLElement | null) {
  if (!root || event.defaultPrevented) return;
  const controls = [...root.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled])")];
  const first = controls[0], last = controls.at(-1);
  if (!first || !last) { event.preventDefault(); root.focus(); return; }
  const at = document.activeElement;
  if (!root.contains(at) || at === root) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
  if (event.shiftKey && at === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && at === last) { event.preventDefault(); first.focus(); }
}

export function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { state, dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Bot | "all" | null>(null);
  const [error, setError] = useState("");
  const deleting = bots.some((bot) => Boolean(state.deletingBots[bot.id]));
  const confirming = pendingDelete !== null;
  const locked = restoringAll || Boolean(busyId) || deleting || confirming;

  useEffect(() => {
    if (bots.length === 0) onClose();
  }, [bots.length, onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
      if (event.key === "Tab" && !confirming) keepTabInside(event, dialogRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirming, locked, onClose]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      openBot(dispatch, response.bot);
      onRestored(t("sidebar.archived.restored", { name: bot.name }));
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    const results = await Promise.allSettled(
      bots.map((bot) =>
        api(`/api/bots/${bot.id}`, {
          method: "PATCH",
          body: JSON.stringify({ hidden: false }),
        }),
      ),
    );
    const restored = results.flatMap((result) => (result.status === "fulfilled" ? [result.value.bot as Bot] : []));
    const left = bots.filter((_, index) => results[index]!.status === "rejected");
    for (const bot of restored) dispatch({ type: "botPatched", bot });
    setRestoringAll(false);
    if (restored[0]) openBot(dispatch, restored[0]);
    if (restored.length > 0) {
      onRestored(restored.length === 1 ? t("sidebar.archived.restoredOne") : t("sidebar.archived.restoredMany", { count: restored.length }));
    }
    if (left.length === 0) {
      onClose();
      return;
    }
    const reason = results.find((result): result is PromiseRejectedResult => result.status === "rejected")!.reason;
    const names = new Intl.ListFormat(activeLocale(), { type: "conjunction" }).format(left.map((bot) => bot.name));
    setError(t("sidebar.archived.restoreFailed", { names, reason: friendlyError(reason) }));
  };

  return createPortal(
    <div
      data-settings-sheet
      data-settings-look="simple"
      className="settings-scrim z-50"
      onMouseDown={(event) => event.target === event.currentTarget && !locked && onClose()}
    >
      <div aria-hidden="true" className="settings-backdrop" style={compactBackdropStyle} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-bots-title"
        tabIndex={-1}
        className="settings-dialog"
        style={{ ...compactSheetStyle(560), maxHeight: "min(640px, calc(100dvh - 32px))" }}
      >
        <section className="settings-panel min-h-0">
          <button type="button" onClick={onClose} disabled={locked} className="settings-close disabled:opacity-40" aria-label={t("sidebar.archived.close")}>
            <X size={14} />
          </button>
          <header className="settings-pane-header">
            <h2 id="archived-bots-title" className="settings-pane-title">{t("sidebar.archived.title")}</h2>
            <div className={cn("flex items-center gap-1", SIMPLE_BUTTONS)}>
              {bots.length > 1 && (
                <button type="button" onClick={() => void restoreAll()} disabled={locked} className="ui-button">
                  {restoringAll && <Loader2 size={12} className="animate-spin" />}
                  {t("sidebar.archived.restoreAll")}
                </button>
              )}
              {bots.length > 0 && (
                <button type="button" onClick={() => setPendingDelete("all")} disabled={locked} className={dangerPillCls}>
                  <Trash2 size={12} />
                  {t("sidebar.archived.deleteAll")}
                </button>
              )}
            </div>
          </header>
          <div className="settings-scroll">
            <div className={cn("settings-pane", SIMPLE_BUTTONS)} style={{ gap: 20, paddingBottom: 20 }}>
              <p className="m-0 px-2.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary text-pretty">{t("sidebar.archived.subtitle")}</p>
              <SettingsGroup label={t("sidebar.archived.count", { count: bots.length })}>
                <div className={cn(SIMPLE_CARD, "flex flex-col")}>
                  {bots.map((bot) => (
                    <ArchivedBotRow
                      key={bot.id}
                      bot={bot}
                      restoring={busyId === bot.id}
                      deleting={Boolean(state.deletingBots[bot.id])}
                      disabled={locked}
                      onRestore={() => void restore(bot)}
                      onDelete={() => setPendingDelete(bot)}
                    />
                  ))}
                </div>
              </SettingsGroup>
              {error && <p role="alert" className="m-0 px-3 text-[13px] leading-[18px] text-danger">{error}</p>}
            </div>
          </div>
        </section>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        {...(pendingDelete === "all"
          ? archivedDeleteAllCopy()
          : botConfirmCopy("delete", pendingDelete?.name ?? ""))}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          const target = pendingDelete;
          setPendingDelete(null);
          if (target === "all") {
            for (const bot of bots) dispatch({ type: "deleteBot", botId: bot.id });
            return;
          }
          dispatch({ type: "deleteBot", botId: target.id });
        }}
      />
    </div>,
    document.body,
  );
}
