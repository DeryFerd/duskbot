// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { resetNotesArrivalForTests } from "@/lib/notes-arrival";
import type { Attachment } from "@/lib/composer-attachments";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  agentsMcp: true,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  liveCall: null as unknown,
  config: undefined as unknown,
  api: vi.fn(async () => ({})),
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, selectedId: "atlas", config: fixture.config ?? original.initialState.config, bots: [bot, { ...peer, defaultBot: {} }], liveCall: fixture.liveCall, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: fixture.agentsMcp },
    }] },
    dispatch: fixture.dispatch,
  }), api: fixture.api };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/default-bot", async (original) => ({ ...(await original<typeof import("@/lib/default-bot")>()), useViewerEmail: () => null }));
vi.mock("./ComposerModelChip", () => ({ ComposerModelChip: () => null }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const peer: Bot = { ...bot, id: "juniper", threadId: "juniper-thread", name: "Juniper", color: "teal" };

let root: Root;
let container: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeEach(() => {
  setLocale("en");
  resetNotesArrivalForTests();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the build log`).join("\n");
const files: Attachment[] = ["one.pdf", "two.csv", "three.md"].map((name, i) => ({ kind: "file", id: `f${i}`, path: `/u/${name}`, name, size: 10 }));

function paste(text: string) {
  const box = container.querySelector("textarea")!;
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : ""), files: [], items: [], types: ["text/plain"] } });
  flushSync(() => box.dispatchEvent(event));
  return event;
}
const tiles = () => [...container.querySelectorAll<HTMLElement>("[data-composer-attachment]")];
const lit = () => tiles().filter((tile) => tile.querySelector("[data-attachment-glow]")).map((tile) => tile.dataset.attachmentId);

describe("a long paste into a message that already has attachments", () => {
  it("lands where it can be seen: the new tile scrolls into view, lights up and is announced with the count", async () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: files });
    flushSync(() => root.render(createElement(Composer, { bot })));
    expect(lit()).toEqual([]);
    const scrolled = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrolled.mockClear();
    expect(paste(LONG).defaultPrevented).toBe(true);
    await settle();
    expect(tiles()).toHaveLength(4);
    const added = tiles().at(-1)!;
    expect(added.dataset.attachmentKind).toBe("paste");
    expect(lit()).toEqual([added.dataset.attachmentId]);
    expect(scrolled.mock.contexts.at(-1)).toBe(added);
    expect(container.querySelector(".sr-only[role=status]")?.textContent).toBe("Pasted text added. 4 attachments in this message.");
  });

  it("is attached once however many times the same text is pasted, and pasting it again shows the one already there", async () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: files });
    flushSync(() => root.render(createElement(Composer, { bot })));
    paste(LONG);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(lit()).toEqual([]);
    const first = tiles().at(-1)!.dataset.attachmentId;
    const scrolled = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrolled.mockClear();
    expect(paste(LONG).defaultPrevented).toBe(true);
    expect(paste(LONG).defaultPrevented).toBe(true);
    await settle();
    expect(tiles().filter((tile) => tile.dataset.attachmentKind === "paste").map((tile) => tile.dataset.attachmentId)).toEqual([first]);
    expect(lit()).toEqual([first]);
    expect(scrolled.mock.contexts.at(-1)).toBe(tiles().at(-1));
    paste(`${LONG}\nand one more line`);
    await settle();
    expect(tiles().filter((tile) => tile.dataset.attachmentKind === "paste")).toHaveLength(2);
  });
});

describe("an attachment whose upload failed", () => {
  it("never holds Send: the message goes without it and the tile stays to retry or remove", async () => {
    const failed: Attachment = { kind: "file", id: "bad", path: "", name: "photo.png", size: 10, failed: true, uploading: false };
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [files[0]!, failed] });
    flushSync(() => root.render(createElement(Composer, { bot })));
    const box = container.querySelector("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    flushSync(() => { setValue.call(box, "here you go"); box.dispatchEvent(new Event("input", { bubbles: true })); });
    const send = container.querySelector<HTMLButtonElement>("[data-composer-send]")!;
    expect(send.disabled).toBe(false);
    flushSync(() => send.click());
    await settle();
    const sent = fixture.dispatch.mock.calls.map(([action]) => action).find((action) => action.type === "send");
    expect(sent?.text).toContain("here you go");
    expect(sent?.text).toContain('name="one.pdf"');
    expect(sent?.text).not.toContain("photo.png");
    expect(tiles().map((tile) => tile.dataset.attachmentId)).toEqual(["bad"]);
  });
});

describe("what an attach leaves out", () => {
  it("shows as an error card with a title, the files and why, and a way to choose again", async () => {
    flushSync(() => root.render(createElement(Composer, { bot })));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [new File(["MZ"], "setup.exe", { type: "application/x-msdownload" })] } });
    window.dispatchEvent(drop);
    await settle();
    const card = container.querySelector("[data-attach-notice=warning]");
    expect(card?.querySelector("[data-chat-error]")?.getAttribute("role")).toBe("status");
    expect(card?.textContent).toContain("Couldn't attach everything");
    expect(card?.textContent).toContain("Unable to attach setup.exe.");
    expect([...card!.querySelectorAll("button")].map((button) => button.textContent || button.getAttribute("aria-label"))).toEqual(["Choose files", "Dismiss"]);
    expect(container.querySelector("[data-composer-strip] p")).toBeNull();
    flushSync(() => card!.querySelector<HTMLButtonElement>("button[aria-label=Dismiss]")!.click());
    expect(container.querySelector("[data-attach-notice]")).toBeNull();
  });

  it("goes once the message is sent", async () => {
    flushSync(() => root.render(createElement(Composer, { bot })));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [new File(["MZ"], "setup.exe", { type: "application/x-msdownload" })] } });
    window.dispatchEvent(drop);
    await settle();
    expect(container.querySelector("[data-attach-notice=warning]")).not.toBeNull();
    flushSync(() => restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "here it is", attachments: [] }));
    const box = container.querySelector("textarea")!;
    flushSync(() => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "here it is" }));
    expect(container.querySelector("[data-attach-notice]")).toBeNull();
  });
});

describe("an attachment row wider than the composer", () => {
  it("fades out at each side that hides tiles and says how many it holds", async () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: files });
    flushSync(() => root.render(createElement(Composer, { bot })));
    const row = container.querySelector<HTMLElement>("[data-composer-attachments]")!;
    let left = 0;
    Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(row, "clientWidth", { configurable: true, get: () => 500 });
    Object.defineProperty(row, "scrollLeft", { configurable: true, get: () => left });
    const scrollTo = (to: number) => { left = to; flushSync(() => row.dispatchEvent(new Event("scroll"))); };
    scrollTo(0);
    expect([row.hasAttribute("data-edge-start"), row.hasAttribute("data-edge-end")]).toEqual([false, true]);
    expect(row.style.maskImage).toContain("transparent");
    expect(container.querySelector("[data-composer-attachment-count]")?.textContent).toBe("3 attachments");
    scrollTo(200);
    expect([row.hasAttribute("data-edge-start"), row.hasAttribute("data-edge-end")]).toEqual([true, true]);
    scrollTo(400);
    expect([row.hasAttribute("data-edge-start"), row.hasAttribute("data-edge-end")]).toEqual([true, false]);
  });
});
