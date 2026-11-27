// @vitest-environment happy-dom
// a toast in a narrow window with the sidebar open sits over the chat, not half over the sidebar's footer
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toast } from "./Toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
  const main = document.body.appendChild(document.createElement("main"));
  vi.spyOn(main, "getBoundingClientRect").mockReturnValue({ left: 300, right: 900, width: 600, top: 0, bottom: 700, height: 700, x: 300, y: 0, toJSON: () => ({}) } as DOMRect);
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

it("centres on the chat column beside an open sidebar", () => {
  act(() => root.render(createElement(Toast, { text: "Sent. Thanks for telling us.", onDone: () => {} })));
  const toast = document.querySelector<HTMLElement>(".ui-toast")!;
  expect(toast.style.insetInlineStart).toBe("600px");
  // happy-dom drops a min() width from style, so the column's width is read from what React wrote
  expect(toast.style.insetInlineStart).not.toBe("450px");
});
