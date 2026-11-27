// @vitest-environment happy-dom
// While the welcome shows, the app behind it takes no focus and reads as hidden, so keyboards and screen readers stay in the welcome.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { showWelcome, useBehindWelcome } from "./onboarding";

function Behind() {
  return createElement("div", { "data-behind": "", ...useBehindWelcome() }, createElement("button", { type: "button" }, "Chat"));
}

it("makes the app behind the welcome inert while the welcome is on screen, and live again once it closes", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(Behind)));
  const behind = () => container.querySelector("[data-behind]")!;
  expect(behind().hasAttribute("inert")).toBe(false);
  let hide = () => {};
  flushSync(() => { hide = showWelcome(); });
  expect(behind().hasAttribute("inert")).toBe(true);
  expect(behind().getAttribute("aria-hidden")).toBe("true");
  flushSync(() => hide());
  expect(behind().hasAttribute("inert")).toBe(false);
  expect(behind().hasAttribute("aria-hidden")).toBe(false);
  flushSync(() => root.unmount());
  container.remove();
});

it("puts the sidebar, the chat and its panels, and the drawer button behind it", () => {
  const source = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
  expect(source).toMatch(/ref=\{menuButtonRef\}\s*\{\.\.\.behindWelcome\}/);
  expect(source).toMatch(/<div data-window-card=\{framed \? "" : undefined\} \{\.\.\.behindWelcome\}/);
});

it("puts the frame bar's settings button and an unframed window's top notices behind it too", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
  expect(app).toMatch(/\{!framed && <div data-notices-behind-welcome className="contents" \{\.\.\.behindWelcome\}>\{strips\}<\/div>\}/);
  const bar = readFileSync(join(process.cwd(), "src/components/WindowFrameBar.tsx"), "utf8");
  expect(bar).toMatch(/<div data-frame-bar-end \{\.\.\.behindWelcome\}[^>]*>\s*<button[^>]*?data-frame-settings/s);
});
