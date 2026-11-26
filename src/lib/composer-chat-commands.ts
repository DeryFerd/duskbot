// `/new` and `/compact [focus]` in the composer: they act on the chat instead of being sent (shared/chat-commands.ts).
import { parseChatCommand } from "../../shared/chat-commands";
import type { ComposerSlashCommand } from "./composer-commands";
import { t } from "./i18n";
import { friendlyError } from "./plain-error";
import { api } from "@/state/store";

/** The / menu's rows for them: a bot's own chat only, never a room. */
export function chatCommandRows(): ComposerSlashCommand[] {
  return [
    { kind: "command", id: "new", label: "/new", description: t("composer.command.newDesc") },
    { kind: "command", id: "compact", label: "/compact", description: t("composer.command.compactDesc") },
  ];
}

type Dispatch = (action: { type: "newTask"; botId: string; from: string } | { type: "error"; message: string }) => void;

/** Starts a fresh chat for the bot from `threadId`, which then captures its memory and says a new chat began. */
export function startNewChat(botId: string, threadId: string, dispatch: Dispatch, clear: () => void): void {
  clear();
  dispatch({ type: "newTask", botId, from: threadId });
}

/** Runs the message as /new or /compact when it is one; true when it was (and nothing is to be sent). */
export function runChatCommand(input: {
  text: string; botId: string; threadId: string; busy: boolean; dispatch: Dispatch; clear(): void; restore(text: string): void;
}): boolean {
  const command = parseChatCommand(input.text);
  if (!command) return false;
  if (command.kind === "new") { startNewChat(input.botId, input.threadId, input.dispatch, input.clear); return true; }
  if (input.busy) { input.dispatch({ type: "error", message: t("chat.compacted.busy") }); return true; }
  input.clear();
  void api(`/api/bots/${input.botId}/compact`, { method: "POST", body: JSON.stringify({ threadId: input.threadId, ...(command.focus ? { focus: command.focus } : {}) }) })
    .catch((cause) => { input.restore(input.text); input.dispatch({ type: "error", message: friendlyError(cause) }); });
  return true;
}
