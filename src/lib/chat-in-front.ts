// Whether the selected chat is in front of the person, which decides if a reply landing in it counts as read. The
// desktop always shows the chat it has selected; the phone shows its list over the chat it last opened, and a chat under
// the list is not being read.
let covered = false;
let away = false;

export function setChatCovered(value: boolean): void {
  covered = value;
  noteChatInFront();
}

/** The phone app went to the background or came back. Android keeps a backgrounded page running, its stream open and
 * its focus as it was, so only the app's own pause says nobody is reading. */
export function setAppAway(value: boolean): void {
  away = value;
  noteChatInFront();
}

export function appAway(): boolean {
  return away;
}

export function chatInFront(doc: Pick<Document, "hasFocus"> = document): boolean {
  return !covered && !away && doc.hasFocus();
}

/** Back in a chat sooner than this after it was last in front, its New line is not drawn. */
export const NEW_DIVIDER_AWAY_MS = 2 * 60_000;

const lastInFront = new Map<string, number>();
let shownThread: string | null = null;
let frontThread: string | null = null;

/** Call with the chat on screen and whenever focus, visibility or the phone's list over it changes. Answers the chat
 * that has just come in front, and whether the person had been away from it long enough for its New line. */
export function noteChatInFront(shown: string | null = shownThread, now = Date.now(), inFront = typeof document !== "undefined" && chatInFront()): { threadId: string; away: boolean } | null {
  shownThread = shown;
  const next = shown && inFront ? shown : null;
  if (frontThread === next) return null;
  if (frontThread) lastInFront.set(frontThread, now);
  const back = next ? { threadId: next, away: awayFromChat(next, now) } : null;
  frontThread = next;
  return back;
}

export function awayFromChat(threadId: string, now = Date.now()): boolean {
  if (threadId === frontThread) return false;
  const seen = lastInFront.get(threadId);
  return seen === undefined || now - seen >= NEW_DIVIDER_AWAY_MS;
}

export function forgetChatsInFront(): void {
  lastInFront.clear();
  shownThread = frontThread = null;
}
