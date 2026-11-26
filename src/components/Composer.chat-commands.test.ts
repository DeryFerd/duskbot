// @vitest-environment happy-dom
// /new and /compact in the real composer: they act on the chat instead of being sent to the bot.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";

const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
const spies = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: spies.api, useStore: () => ({
    state: { ...original.initialState, bots: [bot], instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: true },
    }] },
    dispatch: spies.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/use-slash-skills", () => ({ useSlashSkills: () => [] }));
vi.mock("./CallView", () => ({ CallButton: () => null }));

import { Composer } from "./Composer";

let bot: Bot;
const draftId = "bot:cmd-bot:cmd-thread";

describe("/new and /compact in the composer", () => {
  let root: Root;
  let container: HTMLDivElement;

  const render = (busy = false) => {
    bot = {
      id: "cmd-bot", threadId: "cmd-thread", name: "Atlas", title: "", description: "",
      color: "blue", notifications: false, unread: false, busy, messages: [],
      modelSelection: { instanceId: ENGINE, model: "fake" },
    };
    flushSync(() => root.render(createElement(Composer, { bot })));
  };
  const input = () => container.querySelector("textarea")!;
  const fill = (text: string) => {
    flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] }));
    input().setSelectionRange(text.length, text.length);
    flushSync(() => input().dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true })));
  };
  const enter = () => flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  const actions = () => spies.dispatch.mock.calls.map(([action]) => action as { type: string });
  const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];

  beforeEach(() => {
    spies.dispatch.mockClear();
    spies.api.mockClear();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    render();
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts a new chat on /new, sends nothing and empties the field", () => {
    fill("/new");
    enter();
    expect(actions()).toContainEqual({ type: "newTask", botId: "cmd-bot", from: "cmd-thread" });
    expect(actions().some((action) => action.type === "send")).toBe(false);
    expect(input().value).toBe("");
  });

  it("starts a new chat when /new is picked from the / menu", () => {
    fill("/ne");
    const row = options().find((option) => option.textContent?.includes("/new"));
    expect(row?.textContent).toContain("Memory carries over");
    flushSync(() => row!.click());
    expect(actions()).toContainEqual({ type: "newTask", botId: "cmd-bot", from: "cmd-thread" });
  });

  it("compacts with the focus typed after /compact, and sends nothing", () => {
    fill("/compact keep the vendor emails");
    enter();
    expect(spies.api).toHaveBeenCalledWith("/api/bots/cmd-bot/compact", { method: "POST", body: JSON.stringify({ threadId: "cmd-thread", focus: "keep the vendor emails" }) });
    expect(actions().some((action) => action.type === "send")).toBe(false);
    expect(input().value).toBe("");
  });

  it("puts /compact in the field from the menu so a focus can follow, and a second Enter compacts", () => {
    fill("/comp");
    flushSync(() => options().find((option) => option.textContent?.includes("/compact"))!.click());
    expect(input().value).toBe("/compact ");
    expect(spies.api).not.toHaveBeenCalled();
    fill("/compact ");
    enter();
    expect(spies.api).toHaveBeenCalledWith("/api/bots/cmd-bot/compact", { method: "POST", body: JSON.stringify({ threadId: "cmd-thread" }) });
  });

  it("asks to finish the reply first when /compact is sent mid-reply", () => {
    render(true);
    fill("/compact ");
    enter();
    expect(spies.api).not.toHaveBeenCalled();
    expect(actions()).toContainEqual({ type: "error", message: "Finish or stop the current reply first, then compact" });
  });

  it("sends /new with words after it as an ordinary message", () => {
    fill("/new ideas for the launch");
    enter();
    expect(actions().some((action) => action.type === "newTask")).toBe(false);
    expect(actions().find((action) => action.type === "send")).toMatchObject({ text: "/new ideas for the launch" });
  });

  it("in a room, /new opens a new room conversation and /compact is not offered", () => {
    const room: Group = { id: "room", threadId: "room-thread", name: "Launch", memberIds: [bot.id], defaultResponder: { kind: "member", botId: bot.id },
      bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1, messages: [] };
    flushSync(() => root.render(createElement(Composer, { group: room, members: [bot] })));
    flushSync(() => restoreComposerDraft("group:room:room-thread", { text: "/", attachments: [] }));
    input().setSelectionRange(1, 1);
    flushSync(() => input().dispatchEvent(new KeyboardEvent("keyup", { key: "/", bubbles: true })));
    const labels = options().map((option) => option.querySelector(".truncate")?.textContent);
    expect(labels).toContain("/new");
    expect(labels).not.toContain("/compact");
    flushSync(() => restoreComposerDraft("group:room:room-thread", { text: "/new", attachments: [] }));
    input().setSelectionRange(4, 4);
    flushSync(() => input().dispatchEvent(new KeyboardEvent("keyup", { key: "w", bubbles: true })));
    enter();
    expect(actions()).toContainEqual({ type: "newGroupTask", groupId: "room" });
    expect(actions().some((action) => action.type === "sendGroup")).toBe(false);
    restoreComposerDraft("group:room:room-thread", { text: "", attachments: [] });
  });
});
