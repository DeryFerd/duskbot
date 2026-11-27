// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { initialState, type Bot } from "@/state/store";
import { composerField } from "@/lib/composer-focus";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: initialState, dispatch }) }));
vi.mock("./bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => ({}) }));
vi.mock("./bot-panel/PanelShell", () => ({ BotPanel: () => createElement("button", { type: "button" }, "close") }));

import { BotSettingsDialog } from "./BotSettingsDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  dispatch.mockClear();
  document.body.innerHTML = "";
});

/** A window too narrow to dock the panel: it lies over the whole chat, so whatever sits under the chat box is the panel. */
async function narrowWindow(covered: boolean) {
  document.body.innerHTML = '<div data-tour="composer"><textarea aria-label="Message Alpha"></textarea></div>';
  const field = document.querySelector("textarea")!;
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (this.isConnected ? [{}] : []) as unknown as DOMRectList;
  });
  vi.spyOn(field, "getBoundingClientRect").mockReturnValue({ left: 10, top: 700, width: 400, height: 40 } as DOMRect);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root.render(createElement(BotSettingsDialog, { bot: { id: "alpha", name: "Alpha" } as Bot })); });
  const panel = document.getElementById("bot-panel")!;
  Object.assign(document, { elementFromPoint: () => (covered ? panel.querySelector("button") : field) });
  return { field, root };
}

it("in a narrow window the panel over the chat takes Escape from the chat box under it, and typing never goes there", async () => {
  const { field, root } = await narrowWindow(true);
  expect(composerField(document)).toBeNull();
  field.focus();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { field.dispatchEvent(escape); });
  expect(dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: false });
  act(() => root.unmount());
});

it("docked beside the chat, an empty chat box hands Escape to the panel and a typed one keeps it", async () => {
  const { field, root } = await narrowWindow(false);
  expect(composerField(document)).toBe(field);
  field.focus();
  act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: false });
  dispatch.mockClear();
  field.value = "half a thought";
  act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(dispatch).not.toHaveBeenCalled();
  act(() => root.unmount());
});
