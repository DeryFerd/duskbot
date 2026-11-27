// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MentionTextarea } from "./MentionTextarea";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("draws its words in the field's own type and padding, so the caret stays at the end of the text", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  document.head.appendChild(document.createElement("style")).textContent =
    ".dock { font-size: 14px; line-height: 20px; padding: 4px 2px } .wide { font-size: 15px; line-height: 24px; padding: 4px }";
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const inputRef = createRef<HTMLTextAreaElement>();
  const show = (className: string) => act(async () => {
    root.render(createElement(MentionTextarea, { inputRef, peers: [], className, value: "asdasdasdasjashdjas", onChange: () => {} }));
  });
  const mirror = () => document.querySelector<HTMLElement>(".mention-editor-mirror")!.style;
  await show("dock");
  expect([mirror().fontSize, mirror().lineHeight, mirror().paddingLeft]).toEqual(["14px", "20px", "2px"]);
  await show("wide");
  expect([mirror().fontSize, mirror().lineHeight, mirror().paddingLeft], "and follows the field when its classes change").toEqual(["15px", "24px", "4px"]);
  act(() => root.unmount());
});

it("sits over the field where the wrapper pads it, so the typed words start where the placeholder and the caret do", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const offsetLeft = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return this.tagName === "TEXTAREA" ? 6 : 0; });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const inputRef = createRef<HTMLTextAreaElement>();
  await act(async () => {
    root.render(createElement(MentionTextarea, { inputRef, peers: [], wrapperClassName: "px-1.5", value: "hey", onChange: () => {} }));
  });
  const mirror = document.querySelector<HTMLElement>(".mention-editor-mirror")!.style;
  expect([mirror.left, mirror.right]).toEqual(["6px", "auto"]);
  offsetLeft.mockRestore();
  act(() => root.unmount());
});

it("takes each typed key without rewriting the field's text child (each rewrite restyles the whole chat)", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const inputRef = createRef<HTMLTextAreaElement>();
  const show = (value: string) => act(async () => {
    root.render(createElement(MentionTextarea, { inputRef, peers: [], value, onChange: () => {} }));
  });
  await show("");
  const field = inputRef.current!;
  const rewrites: MutationRecord[] = [];
  const watch = new MutationObserver((records) => rewrites.push(...records));
  watch.observe(field, { childList: true, characterData: true, subtree: true });
  for (const value of ["h", "he", "hey", "hey there", ""]) {
    await show(value);
    expect(field.value).toBe(value);
  }
  await Promise.resolve();
  expect(rewrites.length).toBe(0);
  watch.disconnect();
  act(() => root.unmount());
});

it("draws its words at the field's own size under the phone's text zoom, not zoomed a second time", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
  const mirror = /\.mention-editor-mirror\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(mirror).toMatch(/(^|[^-])text-size-adjust:\s*none/);
  expect(mirror).toMatch(/-webkit-text-size-adjust:\s*none/);
});
