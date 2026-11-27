import { useSyncExternalStore } from "react";

import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";

/** The bot's own settings that open as a centred dialog over the panel instead of a page inside it. */
export const MODAL_PAGES = ["instructions", "memory", "skills", "folder", "where", "backups"] as const;
export type ModalPage = (typeof MODAL_PAGES)[number];

/** Every page of the bot's settings (in Settings' Bots page): the dialog pages, then the bot's tools, permissions, identity and Slack, which
 * only the sheet draws. */
export const SHEET_PAGES = ["instructions", "memory", "skills", "sessions", "identity", "tools", "permissions", "folder", "where", "backups", "slack"] as const;
export type SheetPage = (typeof SHEET_PAGES)[number];

export function sheetLabel(page: SheetPage, bot: Pick<Bot, "name">): string {
  switch (page) {
    case "instructions": return t("botPanel.ui.botSettingsSimpleInstructions");
    case "memory": return t("botPanel.memoryRow");
    case "skills": return t("botPanel.ui.botSettingsSimpleSkills");
    case "sessions": return t("botPanel.sessions.title");
    case "identity": return t("botPanel.ui.botSettingsSectionsIdentity");
    case "tools": return t("botPanel.page.tools");
    case "permissions": return t("botPanel.ui.botSettingsSectionsPermissions");
    case "folder": return t("botPanel.page.folder");
    case "where": return t("botPanel.ui.computerSimpleWhereWorks", { name: bot.name });
    case "backups": return t("botPanel.page.backups");
    case "slack": return t("botPanel.page.slack");
  }
}

export function isModalPage(page: string | undefined): page is ModalPage {
  return page !== undefined && (MODAL_PAGES as readonly string[]).includes(page);
}

export interface ModalRequest {
  page: SheetPage;
  nonce: number;
}

let pending: ModalRequest | null = null;
let count = 0;
const watchers = new Set<() => void>();
// a request can be made while the panel renders: tell the watchers after it
const notify = () => queueMicrotask(() => { for (const watch of Array.from(watchers)) watch(); });

/** Asks the Advanced tab to open `page`'s dialog; a deep link lands there and the tab picks the request up. */
export function requestPanelModal(page: SheetPage): void {
  pending = { page, nonce: ++count };
  notify();
}

/** Marks a request as handled, unless a newer one came meanwhile. */
export function takePanelModalRequest(request: ModalRequest): void {
  if (pending !== request) return;
  pending = null;
  notify();
}

function subscribe(watch: () => void) {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

const snapshot = () => pending;

export function usePanelModalRequest(): ModalRequest | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The dialog asked for and not yet opened, if any. */
export function pendingPanelModal(): ModalRequest | null {
  return pending;
}
