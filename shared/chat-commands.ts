// `/new` and `/compact [focus]`: typed in the app's composer, on the phone, in Telegram or Discord, or sent through the
// API, they act on the conversation instead of reaching the bot as words. Shared so every surface reads them alike.
// `/reset` (Telegram's old name) and `/compress` (Hermes Agent's) are accepted too.

export const COMPACT_FOCUS_MAX = 1_000;

export type ChatCommand = { kind: "new" } | { kind: "compact"; focus: string };

/** The whole message is one command: `/new`, or `/compact` with an optional focus. A chat app's `@handle` after the
 * name is allowed. Anything else, a command inside a sentence included, is ordinary text. */
export function parseChatCommand(text: string): ChatCommand | null {
  const match = /^\s*\/([a-z]+)(?:@[\w]+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const rest = (match[2] ?? "").trim();
  if (name === "new" || name === "reset") return rest ? null : { kind: "new" };
  if (name === "compact" || name === "compress") return { kind: "compact", focus: rest.slice(0, COMPACT_FOCUS_MAX) };
  return null;
}

/** A focus from a request body: undefined when none was sent, null when it is not usable text. */
export function compactFocus(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const focus = value.replace(/\s+/g, " ").trim();
  if (focus.length > COMPACT_FOCUS_MAX) return null;
  return focus || undefined;
}
