// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createShortcutHold, SHORTCUT_HOLD_MS, shortcutBadgeText } from "./SidebarShortcutHold";

const ids = Array.from({ length: 11 }, (_, index) => `row${index + 1}`);
const down = (key: string, init: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));
const up = (key: string) => window.dispatchEvent(new KeyboardEvent("keyup", { key }));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("numbers the first nine shown rows once ⌘ alone is held for 300 ms, keeps them through a number, and clears on release", () => {
  const hold = createShortcutHold("Meta", () => ids);
  const changed = vi.fn();
  const stop = hold.subscribe(changed);
  down("Meta", { metaKey: true });
  vi.advanceTimersByTime(SHORTCUT_HOLD_MS - 1);
  expect(hold.slot("row1")).toBeNull();
  vi.advanceTimersByTime(1);
  expect([hold.slot("row1"), hold.slot("row9"), hold.slot("row10")]).toEqual([1, 9, null]);
  down("2", { metaKey: true });
  expect(hold.slot("row2")).toBe(2);
  up("Meta");
  expect(hold.slot("row1")).toBeNull();
  expect(changed).toHaveBeenCalledTimes(2);
  stop();
});

it("never shows the numbers for a quick ⌘C, a ⌘-click or a ⌘2 pressed before they appear", () => {
  const hold = createShortcutHold("Meta", () => ids);
  const changed = vi.fn();
  const stop = hold.subscribe(changed);
  for (const chord of [() => down("c", { metaKey: true }), () => window.dispatchEvent(new Event("pointerdown")), () => down("2", { metaKey: true })]) {
    down("Meta", { metaKey: true });
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS / 2);
    chord();
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS * 3);
    expect(hold.slot("row1")).toBeNull();
    up("Meta");
  }
  expect(changed).not.toHaveBeenCalled();
  stop();
});

it("hides the numbers when another key is pressed while they show", () => {
  const hold = createShortcutHold("Control", () => ids);
  const stop = hold.subscribe(() => {});
  down("Control", { ctrlKey: true });
  vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
  expect(hold.slot("row3")).toBe(3);
  down("k", { ctrlKey: true });
  expect(hold.slot("row3")).toBeNull();
  stop();
});

it("shows nothing for ⌘ with Shift, Option or Control, and lets go on blur", () => {
  const hold = createShortcutHold("Meta", () => ids);
  const stop = hold.subscribe(() => {});
  down("Meta", { metaKey: true });
  down("Shift", { metaKey: true, shiftKey: true });
  vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
  expect(hold.slot("row1")).toBeNull();
  down("Meta", { metaKey: true });
  vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
  expect(hold.slot("row1")).toBe(1);
  window.dispatchEvent(new Event("blur"));
  expect(hold.slot("row1")).toBeNull();
  stop();
});

it("writes ⌘ on a Mac and Ctrl elsewhere", () => {
  expect(shortcutBadgeText("Meta", 3)).toBe("⌘3");
  expect(shortcutBadgeText("Control", 3)).toBe("Ctrl+3");
});
