// `/new` and `/compact [focus]` in the composer: they act on the chat instead of being sent (shared/chat-commands.ts).
import { parseChatCommand } from "../../shared/chat-commands";
import type { ComposerSlashCommand } from "./composer-commands";
import { t } from "./i18n";
import { friendlyError } from "./plain-error";
import { api } from "@/state/store";

/** The / menu's rows for them. A room has /new only: each of its bots' context is compacted on its own. */
export function chatCommandRows(room = false): ComposerSlashCommand[] {
  return [
    { kind: "command", id: "new", label: "/new", description: t(room ? "composer.command.newRoomDesc" : "composer.command.newDesc") },
    ...(room ? [] : [{ kind: "command" as const, id: "compact" as const, label: "/compact" as const, description: t("composer.command.compactDesc") }]),
  ];
}

type Dispatch = (action: { type: "newTask"; botId: string; from: string } | { type: "newGroupTask"; groupId: string } | { type: "error"; message: string }) => void;
/** A bot's chat (`botId`) or a room's (`groupId`). */
export type ChatTarget = { botId: string; groupId?: undefined } | { groupId: string; botId?: undefined };

/** Starts a fresh chat from `threadId`: a bot's captures its memory first; a room opens a new conversation. */
export function startNewChat(target: ChatTarget, threadId: string, dispatch: Dispatch, clear: () => void): void {
  clear();
  dispatch(target.groupId ? { type: "newGroupTask", groupId: target.groupId } : { type: "newTask", botId: target.botId!, from: threadId });
}

/** Runs the message as /new or /compact when it is one; true when it was (and nothing is to be sent). */
export function runChatCommand(input: {
  text: string; target: ChatTarget; threadId: string; busy: boolean; dispatch: Dispatch; clear(): void; restore(text: string): void;
}): boolean {
  const command = parseChatCommand(input.text);
  if (!command) return false;
  if (command.kind === "new") { startNewChat(input.target, input.threadId, input.dispatch, input.clear); return true; }
  if (input.target.groupId) return false;
  if (input.busy) { input.dispatch({ type: "error", message: t("chat.compacted.busy") }); return true; }
  input.clear();
  void api(`/api/bots/${input.target.botId}/compact`, { method: "POST", body: JSON.stringify({ threadId: input.threadId, ...(command.focus ? { focus: command.focus } : {}) }) })
    .catch((cause) => { input.restore(input.text); input.dispatch({ type: "error", message: friendlyError(cause) }); });
  return true;
}
