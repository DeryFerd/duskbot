import { useSyncExternalStore } from "react";

import { shownRowIds } from "@/lib/sidebar-shortcut-order";

/** Long enough that ⌘C, ⌘V and the like never flash the hints; a deliberate hold still feels immediate. */
export const SHORTCUT_HOLD_MS = 300;

export type ShortcutModifier = "Meta" | "Control";

export const shortcutModifier = (): ShortcutModifier =>
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "Meta" : "Control";

export const shortcutBadgeText = (modifier: ShortcutModifier, n: number) => `${modifier === "Meta" ? "⌘" : "Ctrl+"}${n}`;

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "OS"]);

type Listener = () => void;

/** The held modifier and, while held on its own, each shown row's 1-based slot in the order ⌘1…⌘9 opens (App.tsx). */
export function createShortcutHold(modifier: ShortcutModifier, readOrder: () => string[]) {
  const listeners = new Set<Listener>();
  let slots: Map<string, number> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (next: Map<string, number> | null) => {
    if (slots === next) return;
    slots = next;
    for (const listener of listeners) listener();
  };
  const release = () => {
    clearTimeout(timer);
    timer = undefined;
    set(null);
  };
  const other = (event: KeyboardEvent) => event.altKey || event.shiftKey || (modifier === "Meta" ? event.ctrlKey : event.metaKey);
  const onDown = (event: KeyboardEvent) => {
    if (other(event)) return release();
    if (event.key === modifier) {
      if (document.visibilityState === "hidden" || slots || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        set(new Map(readOrder().slice(0, 9).map((id, index) => [id, index + 1])));
      }, SHORTCUT_HOLD_MS);
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    // a chord like ⌘C, or a key pressed once the hints show that is not one of their numbers
    if (timer || !/^[1-9]$/.test(event.key)) release();
  };
  const onUp = (event: KeyboardEvent) => {
    if (event.key === modifier || !event.getModifierState(modifier)) release();
  };
  const onVisibility = () => { if (document.visibilityState === "hidden") release(); };
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        window.addEventListener("keydown", onDown, true);
        window.addEventListener("keyup", onUp, true);
        window.addEventListener("pointerdown", release, true);
        window.addEventListener("blur", release);
        document.addEventListener("visibilitychange", onVisibility);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        window.removeEventListener("keydown", onDown, true);
        window.removeEventListener("keyup", onUp, true);
        window.removeEventListener("pointerdown", release, true);
        window.removeEventListener("blur", release);
        document.removeEventListener("visibilitychange", onVisibility);
        release();
      };
    },
    slot: (rowId: string) => slots?.get(rowId) ?? null,
  };
}

let shared: ReturnType<typeof createShortcutHold> | null = null;
const hold = () => (shared ??= createShortcutHold(shortcutModifier(), () => shownRowIds(document.querySelector("[data-sidebar-root]"))));

const noSubscribe = () => () => {};

/** This bot's or group chat's number while ⌘ (Ctrl elsewhere) is held, else null. */
export function useShortcutSlot(rowId: string, enabled = true): number | null {
  const store = hold();
  return useSyncExternalStore(
    enabled ? store.subscribe : noSubscribe,
    () => (enabled ? store.slot(rowId) : null),
    () => null,
  );
}

/** A small tonal key cap at the row's right end, where its unread dot sits. */
export function ShortcutBadge({ n }: { n: number }) {
  return (
    <span aria-hidden="true" data-shortcut-badge="" className="pointer-events-none absolute inset-y-0 right-2 flex items-center max-md:hidden touch:hidden">
      <span className="flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-ink/[0.07] px-1 text-[11px] font-medium leading-4 tabular-nums text-ink-secondary">
        {shortcutBadgeText(shortcutModifier(), n)}
      </span>
    </span>
  );
}
