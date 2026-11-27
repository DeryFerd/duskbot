// keyboard focus belongs in the chat box unless the person is using something else. two app-wide rules live here:
// typing a letter while nothing editable has focus types it into the chat box (as in slack), and when a dialog, menu,
// panel or the search closes and leaves focus on nothing or on a plain button, the chat box gets it back.
// opening or switching a chat is the composer's own mount focus (Composer.tsx).
import { shouldOpenKeyboardShortcuts } from "./keyboard-shortcuts";

export const COMPOSER_FIELD = '[data-tour="composer"] textarea';
/** What counts as something open on top of the chat: closing one of these hands focus back to the chat box. */
export const OVERLAY = '[role=dialog], [role=alertdialog], [aria-modal=true], [role=menu], [role=listbox], [data-panel-slot=open]';
/** Places that own their own typing (menus type-ahead, lists move by letter). */
const OWNS_TYPING = "[role=dialog], [role=alertdialog], [aria-modal=true], [role=menu], [role=menubar], [role=listbox], [role=tree], [role=grid], [role=combobox], [role=application]";
/** How long after a close the focus is still watched: dialogs fade out before they leave the page. */
const SETTLE_CHECKS_MS = [0, 120, 320, 520, 720];

interface KeyLike {
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

interface FocusLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?(selector: string): FocusLike | null;
  getAttribute?(name: string): string | null;
}

/** inside something with typing of its own; the bot panel docked beside the chat is not one, only its fields and menus */
function ownsTyping(active: FocusLike): boolean {
  const owner = active.closest?.(OWNS_TYPING);
  if (!owner) return false;
  const docked = owner.getAttribute?.("role") === "dialog" && owner.getAttribute?.("aria-modal") !== "true" && Boolean(owner.closest?.("[data-panel-slot]"));
  return !docked;
}

export function isEditable(active: FocusLike | null | undefined): boolean {
  if (!active) return false;
  const tag = active.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(active.isContentEditable);
}

/** A printable key pressed while focus is on nothing editable, with nothing open that takes typing itself. */
export function keyTypesIntoComposer(event: KeyLike, active: FocusLike | null | undefined, overlayOpen: boolean): boolean {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
  // one character only: Enter, Tab, arrows, "Dead" and "Process" (an input method starting) stay where they are
  if ([...event.key].length !== 1) return false;
  // space presses buttons and scrolls the conversation
  if (event.key === " ") return false;
  if (overlayOpen) return false;
  if (isEditable(active)) return false;
  if (active && ownsTyping(active)) return false;
  return true;
}

/** After something closed: focus fell to the page, or back onto a button or row that has no typing of its own. */
export function focusReturnsToComposer(active: FocusLike | null | undefined, isPage: boolean, overlayOpen: boolean): boolean {
  if (overlayOpen) return false;
  if (!active || isPage) return true;
  if (isEditable(active)) return false;
  return !ownsTyping(active);
}

/** An Escape pressed with focus on nothing in particular (the page, the conversation, a plain button): a docked panel
 * takes it as its own. A field, a menu or another dialog keeps its Escape. */
export function escapeIsUnclaimed(target: FocusLike | null | undefined, isPage: boolean): boolean {
  if (!target || isPage) return true;
  if (isEditable(target)) return false;
  return !ownsTyping(target);
}

const shown = (element: Element) => !element.closest("[inert]") && (element as HTMLElement).getClientRects().length > 0;

/** `blocking`: only what sits over the chat. the bot panel docked beside it is open but leaves the chat usable, so
 * typing still reaches the chat box and a menu closing still hands focus back. */
export function openOverlays(doc: Document = document, blocking = false): number {
  let count = 0;
  for (const element of doc.querySelectorAll(OVERLAY)) {
    if (!shown(element)) continue;
    if (blocking && element.closest("[data-panel-slot]") && !element.closest("[aria-modal=true]")) continue;
    count += 1;
  }
  return count;
}

/** The bot or room panel lies over this element, as it does over the whole chat in a window too narrow to dock it. */
export function underPanel(element: Element, doc: Document = element.ownerDocument): boolean {
  if (typeof doc.elementFromPoint !== "function") return false;
  const box = element.getBoundingClientRect();
  if (!box.width || !box.height) return false;
  const hit = doc.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return Boolean(hit && !element.contains(hit) && hit.closest("[data-panel-slot], #bot-panel"));
}

/** The chat box with nothing typed in it: an Escape there has nothing of its own to cancel. */
export function emptyComposerField(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement && target.matches(COMPOSER_FIELD) && !target.value.trim();
}

export function composerField(doc: Document = document): HTMLTextAreaElement | null {
  const fields = [...doc.querySelectorAll<HTMLTextAreaElement>(COMPOSER_FIELD)].filter((field) => shown(field) && !field.disabled && !field.readOnly && !underPanel(field, doc));
  return fields.at(-1) ?? null;
}

const touchScreen = () => Boolean(window.matchMedia?.("(hover: none) and (pointer: coarse)").matches);

function focusField(field: HTMLTextAreaElement) {
  field.focus({ preventScroll: true });
  const end = field.value.length;
  field.setSelectionRange(end, end);
}

export function watchComposerFocus(win: Window = window): () => void {
  const doc = win.document;
  let pending: ReturnType<typeof setTimeout>[] = [];
  const cancel = () => { for (const timer of pending) clearTimeout(timer); pending = []; };

  const onPage = () => { const active = doc.activeElement; return !active || active === doc.body || active === doc.documentElement; };
  // after an Escape or a click, watch for something on top having closed, or for focus having fallen to the page
  // because what held it left (a close button, the search folding away), then hand focus back
  const watchClose = (before: number, holder: Element | null) => {
    cancel();
    if (touchScreen()) return;
    pending = SETTLE_CHECKS_MS.map((delay) => setTimeout(() => {
      const now = openOverlays(doc);
      const active = doc.activeElement;
      const isPage = onPage();
      if (now >= before && !(isPage && holder && !holder.isConnected)) return;
      // a closing panel can keep focus while it slides away; wait for it to let go
      if (active?.closest("[inert]")) return;
      cancel();
      const field = composerField(doc);
      if (!field || active === field || !focusReturnsToComposer(active, isPage, openOverlays(doc, true) > 0)) return;
      focusField(field);
    }, delay));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Escape closes things; Enter picks a search result or saves a rename, and the field it was typed in folds away
    if (event.key === "Escape" || event.key === "Enter") { watchClose(openOverlays(doc), onPage() ? null : doc.activeElement); return; }
    cancel();
    if (shouldOpenKeyboardShortcuts(event)) return;
    const active = doc.activeElement;
    if (!keyTypesIntoComposer(event, active, openOverlays(doc, true) > 0)) return;
    const field = composerField(doc);
    if (!field || field === active) return;
    // focus moves before the key lands, so the browser types the letter into the chat box itself
    focusField(field);
  };
  // Escape and Enter are read in the capture phase: what they close may stop them from bubbling
  const closing = (event: KeyboardEvent) => event.key === "Escape" || event.key === "Enter";
  const onEscapeCapture = (event: KeyboardEvent) => { if (closing(event)) onKeyDown(event); };
  const onBubble = (event: KeyboardEvent) => { if (!closing(event)) onKeyDown(event); };
  // a click, not the pointer going down: a menu item closes its menu and opens the next thing on click
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest("button, [role=button], [role=menuitem], a") : null;
    watchClose(openOverlays(doc), target);
  };

  win.addEventListener("keydown", onEscapeCapture, true);
  win.addEventListener("keydown", onBubble);
  win.addEventListener("click", onClick, true);
  return () => {
    cancel();
    win.removeEventListener("keydown", onEscapeCapture, true);
    win.removeEventListener("keydown", onBubble);
    win.removeEventListener("click", onClick, true);
  };
}
