// @vitest-environment happy-dom
// the message menu stays inside the chat column: a sidebar or the bot panel beside it would cover the part that ran past
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { MESSAGE_ROW, MessageActions } from "./MessageActions";

let host: HTMLElement;
let root: Root;
const box = (left: number, right: number, top = 100, bottom = 130) => ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

async function open(side: "bot" | "user", tray: DOMRect) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.tagName === "MAIN") return box(300, 900, 0, 800);
    if (this.getAttribute("role") === "menu") return box(0, 220, 0, 90);
    if (this.getAttribute("data-testid") === "message-actions" || this.getAttribute("aria-haspopup") === "menu") return tray;
    return box(0, 0, 0, 0);
  });
  await act(async () => {
    root.render(createElement("div", { [MESSAGE_ROW]: "" }, createElement(MessageActions, {
      side, forceOpen: true,
      menu: [{ key: "pin", icon: null, label: "Pin message", onSelect: () => {} }],
      children: createElement("button", { type: "button" }, "copy"),
    })));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
  return host.querySelector<HTMLElement>("[role=menu]")!;
}

beforeEach(() => {
  setLocale("en");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  host = document.createElement("main");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("message menu at the chat column's edge", () => {
  it("a bot message's menu near the bot panel opens toward the chat", async () => {
    const menu = await open("bot", box(760, 820));
    expect(menu.className).toContain("end-0");
  });

  it("your message's menu near the sidebar opens toward the chat", async () => {
    const menu = await open("user", box(320, 380));
    expect(menu.className).toContain("start-0");
  });

  it("a menu with room stays where it opens", async () => {
    expect((await open("bot", box(400, 460))).className).toContain("start-0");
  });
});
