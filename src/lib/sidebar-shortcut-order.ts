/**
 * The bots that ⌘⇧[ / ⌘⇧] step through, in the order the sidebar shows them. Sections, a custom bot
 * order, collapsed sections, pinned tiles and a search all change that order, so it is read from the rendered rows
 * instead of being rebuilt from `state.bots`.
 */
export function shownBotIds(root: ParentNode | null | undefined): string[] {
  if (!root) return [];
  const ids = [...root.querySelectorAll<HTMLElement>("[data-sidebar-bot-row]")].map((row) => row.dataset.sidebarBotRow ?? "");
  return [...new Set(ids.filter(Boolean))];
}

/** The bot and group chat rows ⌘1…⌘9 open, in the order the sidebar renders them. */
export function shownRowIds(root: ParentNode | null | undefined): string[] {
  if (!root) return [];
  const ids = [...root.querySelectorAll<HTMLElement>("[data-sidebar-bot-row], [data-sidebar-group-row]")]
    .map((row) => row.dataset.sidebarBotRow ?? row.dataset.sidebarGroupRow ?? "");
  return [...new Set(ids.filter(Boolean))];
}

export type ShortcutTarget<B, G> = { kind: "bot"; bot: B } | { kind: "group"; group: G };

/** What ⌘1…⌘9 open: bots and group chats in the sidebar's order; with no sidebar on screen, the bots then the group chats. */
export function shortcutTargets<B extends { id: string }, G extends { id: string }>(bots: readonly B[], groups: readonly G[], shownIds: readonly string[]): ShortcutTarget<B, G>[] {
  const all: ShortcutTarget<B, G>[] = [...bots.map((bot) => ({ kind: "bot" as const, bot })), ...groups.map((group) => ({ kind: "group" as const, group }))];
  if (shownIds.length === 0) return all.slice(0, 9);
  const byId = new Map(all.map((target) => [target.kind === "bot" ? target.bot.id : target.group.id, target]));
  return shownIds.flatMap((id) => byId.get(id) ?? []).slice(0, 9);
}

/** `bots` in the sidebar's order; with no sidebar on screen, `bots` as they are. */
export function shortcutBots<T extends { id: string }>(bots: readonly T[], shownIds: readonly string[]): T[] {
  if (shownIds.length === 0) return [...bots];
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  return shownIds.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The bot ⌘⇧] (`step` 1) or ⌘⇧[ (`step` -1) opens. A selected bot that is not in `bots`, such as one in a
 * collapsed section, counts as standing just outside the list: ] opens the first bot and [ the last.
 */
export function nextShortcutBot<T extends { id: string }>(bots: readonly T[], selectedId: string | null | undefined, step: 1 | -1): T | undefined {
  if (bots.length === 0) return undefined;
  const index = bots.findIndex((bot) => bot.id === selectedId);
  if (index === -1) return step > 0 ? bots[0] : bots.at(-1);
  return bots[(index + step + bots.length) % bots.length];
}
