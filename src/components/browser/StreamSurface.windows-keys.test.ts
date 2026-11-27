// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { PreviewStreamControl, PreviewStreamEvents, PreviewStreamInput } from "@/lib/browser-stream-client";
import { StreamSurface } from "./StreamSurface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { constructor(readonly cb: () => void) {} observe() { queueMicrotask(this.cb); } disconnect() {} });
  vi.stubGlobal("createImageBitmap", async () => ({ width: 1600, height: 1000, close() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as never);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, x: 0, y: 0, right: 1600, bottom: 1000, width: 1600, height: 1000, toJSON() {} } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1600);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1000);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });

async function mount() {
  const input = vi.fn<(message: PreviewStreamInput) => void>();
  let events!: PreviewStreamEvents;
  const connect = vi.fn((_t: unknown, handlers: PreviewStreamEvents) => { events = handlers; return { send: () => true, stop() {} }; });
  await act(async () => root.render(createElement(StreamSurface, { connect, input })));
  await flush();
  const control: PreviewStreamControl = { canOperate: true, controller: "you", generation: 1, dialog: null };
  await act(async () => { events.onViewport({ width: 1600, height: 1000 }); events.onConnectedChange(true); events.onControl?.(control); events.onFrame(new ArrayBuffer(8)); });
  await flush();
  return { input, page: host.querySelector("textarea")! };
}

/** what reached the page as typed characters: key events carrying text, and text inputs */
const typed = (input: ReturnType<typeof vi.fn>) => input.mock.calls.map(([m]) => m as PreviewStreamInput)
  .map((m) => m.type === "text" ? m.text : m.type === "key" && m.action === "down" && "text" in m && m.text ? m.text : "").join("");

/** Chrome on Windows reports AltGr as Ctrl+Alt: the key's character still arrives through the textarea's input event */
async function windowsKey(page: HTMLTextAreaElement, key: string, code: string, mods: { ctrlKey?: boolean; altKey?: boolean } = {}) {
  await act(async () => {
    const down = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods });
    page.dispatchEvent(down);
    if (!down.defaultPrevented && [...key].length === 1) {
      page.value += key;
      page.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: key }));
    }
    page.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true, cancelable: true, ...mods }));
  });
}

it("types a password with AltGr characters on a Windows German keyboard exactly once each", async () => {
  const { input, page } = await mount();
  page.focus();
  for (const ch of "Pa") await windowsKey(page, ch, `Key${ch.toUpperCase()}`);
  await windowsKey(page, "@", "KeyQ", { ctrlKey: true, altKey: true });
  await windowsKey(page, "€", "KeyE", { ctrlKey: true, altKey: true });
  await windowsKey(page, "{", "Digit7", { ctrlKey: true, altKey: true });
  await windowsKey(page, "1", "Digit1");
  expect(typed(input)).toBe("Pa@€{1");
  const chords = input.mock.calls.map(([m]) => m as PreviewStreamInput).filter((m) => m.type === "key" && m.action === "down" && (m.key === "@" || m.key === "€" || m.key === "{"));
  expect(chords.map((m) => m.type === "key" ? m.modifiers : null), "an AltGr character is not sent as a Ctrl+Alt shortcut").toEqual([0, 0, 0]);
});

it("still sends a real Ctrl+Alt shortcut on a letter as that shortcut", async () => {
  const { input, page } = await mount();
  page.focus();
  await windowsKey(page, "t", "KeyT", { ctrlKey: true, altKey: true });
  const down = input.mock.calls.map(([m]) => m as PreviewStreamInput).find((m) => m.type === "key" && m.action === "down");
  expect(down).toMatchObject({ key: "t", modifiers: 3 });
  expect(down && "text" in down ? down.text : undefined).toBeUndefined();
});
