// where each setting lives and the action that opens Settings there: kept apart from the Settings screens so a link to
// Settings from the chat or the panel never pulls those screens into the launch bundle
import { useSyncExternalStore } from "react";
import type { LocaleKey } from "@/locales";
import type { Action, AppSettingsSection } from "@/state/store";
import type { IconName } from "@/components/Icon";

export type AdvancedPage = "apps" | "team" | "data";

export const ADVANCED_PAGES: ReadonlyArray<{ id: AdvancedPage; icon: IconName; sections: AppSettingsSection[] }> = [
  { id: "apps", icon: "plug", sections: ["apps", "skills", "builder", "experimental"] },
  { id: "team", icon: "building", sections: ["organization", "people"] },
  { id: "data", icon: "database", sections: ["data", "backups"] },
];

export type SettingsPane = "general" | "voice" | "texting" | "computer" | "permissions" | "vault" | "models" | "bots" | "usage" | "updates" | "advanced";

/** Grok's panes, with Phone, Models and Advanced features for what Grok has no pane for. Bots is not on the rail: a bot
 * is set up in its own panel, and Bots only hosts the page one of the panel's rows opens. */
export const SETTINGS_PANES: ReadonlyArray<{ id: SettingsPane; labelKey: LocaleKey; icon: IconName; sections: readonly AppSettingsSection[]; rail?: false }> = [
  { id: "general", labelKey: "settings.section.general", icon: "settings-gear", sections: ["general", "appearance", "looks", "import"] },
  // voice input runs on this device, so it shows here even while this app shows another computer
  { id: "voice", labelKey: "settings.voice.title", icon: "mic", sections: ["voice"] },
  { id: "texting", labelKey: "settings.grok.group.phone", icon: "chat-bubbles", sections: ["texting", "companion"] },
  { id: "computer", labelKey: "settings.simple.page.computer", icon: "display", sections: ["computer", "desktopWorkspaces", "remote", "transfer"] },
  { id: "permissions", labelKey: "settings.pane.permissions", icon: "shield", sections: ["permissions", "botAccess", "activity"] },
  { id: "vault", labelKey: "settings.w6.pane.vault", icon: "vault", sections: ["logins"] },
  { id: "models", labelKey: "settings.pane.models", icon: "sparkle", sections: ["engines", "connections"] },
  { id: "bots", labelKey: "settings.pane.bots", icon: "robot", sections: ["bots"], rail: false },
  { id: "usage", labelKey: "settings.pane.usage", icon: "chart-bars", sections: ["usage", "cloudAccount"] },
  { id: "updates", labelKey: "settings.simple.page.updates", icon: "cloud-download", sections: ["updates", "about"] },
  { id: "advanced", labelKey: "settings.pane.advanced", icon: "sliders", sections: ["advanced", ...ADVANCED_PAGES.flatMap((page) => page.sections)] },
];

export type SettingsLocation = { pane: SettingsPane; page?: AdvancedPage };

/** Where a section lives now: its pane, and inside Advanced its page. Every old deep link lands somewhere. */
export function settingsLocation(section: AppSettingsSection): SettingsLocation {
  const page = ADVANCED_PAGES.find((entry) => entry.sections.includes(section));
  if (page) return { pane: "advanced", page: page.id };
  return { pane: SETTINGS_PANES.find((pane) => pane.sections.includes(section))?.id ?? "general" };
}

/** Pages that grew into their own pane: links to the old Advanced page still land. */
const MOVED_PAGES = { ai: "models", billing: "usage" } as const satisfies Record<string, SettingsPane>;

/** Open Settings at a pane, an Advanced page, or the section that holds a setting. */
export function openSettings(target: SettingsPane | AdvancedPage | keyof typeof MOVED_PAGES | AppSettingsSection = "general"): Action {
  const moved = (MOVED_PAGES as Record<string, SettingsPane>)[target];
  const pane = SETTINGS_PANES.find((entry) => entry.id === (moved ?? target));
  const page = ADVANCED_PAGES.find((entry) => entry.id === target);
  const section = pane ? pane.sections[0]! : page ? page.sections[0]! : (target as AppSettingsSection);
  return { type: "toggleAppSettings", open: true, section };
}

/** A row of a bot's settings on the Bots pane, each opening its page there; or a group chat's. */
export type BotSettingsRow = "instructions" | "memory" | "skills" | "sessions" | "identity" | "tools" | "permissions" | "folder" | "where" | "backups" | "slack";
export type RoomSettingsRow = "instructions" | "responder" | "folder" | "about";

export type SettingsBotTarget =
  | { kind: "bot"; id: string; row?: BotSettingsRow; nonce: number }
  | { kind: "group"; id: string; row?: RoomSettingsRow; nonce: number };

let botTarget: SettingsBotTarget | null = null;
let nonce = 0;
const watchers = new Set<() => void>();
const notify = () => { for (const watch of Array.from(watchers)) watch(); };
const subscribe = (watch: () => void) => { watchers.add(watch); return () => { watchers.delete(watch); }; };

/** Open Settings on the Bots pane with this bot (or group chat) picked, at one of its rows' pages when given. */
export function openBotSettings(target: { kind: "bot"; id: string; row?: BotSettingsRow } | { kind: "group"; id: string; row?: RoomSettingsRow }): Action {
  botTarget = { ...target, nonce: ++nonce } as SettingsBotTarget;
  notify();
  return { type: "toggleAppSettings", open: true, section: "bots" };
}

/** The bot or group chat asked for, until Settings has acted on it. */
export function useBotTarget(): SettingsBotTarget | null {
  return useSyncExternalStore(subscribe, () => botTarget, () => botTarget);
}

export function consumeBotTarget(): void {
  if (!botTarget) return;
  botTarget = null;
  notify();
}
