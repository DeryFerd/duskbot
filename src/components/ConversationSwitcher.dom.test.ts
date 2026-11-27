// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: fixture.dispatch }) };
});

const { ChatHeadPill } = await import("./ChatHeadPill");
const { botConversations, hasSideConversations } = await import("@/lib/bot-conversations");
const { ConversationsCard } = await import("./bot-panel/ConversationsCard");

const now = Date.now();
const task = (threadId: string, title: string, minutesAgo: number, extra: Partial<Task> = {}): Task =>
  ({ threadId, title, createdAt: now - 86_400_000, updatedAt: now - minutesAgo * 60_000, ...extra });
const bot = (threadId: string, tasks: Task[], extra: Partial<Bot> = {}): Bot => ({
  id: "pepper", threadId, mainThreadId: "main", name: "Pepper", title: "", description: "", notifications: true, color: "purple",
  unread: false, modelSelection: { instanceId: "fake", model: "fake" }, tasks, messages: [], ...extra,
} as unknown as Bot);

const one = [task("main", "plan my week around the launch", 5)];
const two = [...one, task("older", "Quarter numbers", 90, { side: true }), task("fresh", "New thread", 1, { side: true }), task("run", "Morning run", 0, { routineRunId: "r" }), task("gone", "Old one", 3, { archivedAt: 1 })];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});
const show = (node: ReturnType<typeof createElement>) => flushSync(() => root.render(node));
const pill = (of: Bot) => createElement(ChatHeadPill, { bot: of, avatar: { state: "idle", motion: "none", motionKey: 0, animated: false } as never, onToggle: vi.fn() });
const click = (element: Element | null) => flushSync(() => (element as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));

describe("a bot's conversations", () => {
  it("lists the main one first, then the rest newest first, never a routine run or an archived one", () => {
    expect(botConversations(bot("main", two)).map((entry) => entry.threadId)).toEqual(["main", "fresh", "older"]);
    expect(hasSideConversations(bot("main", two))).toBe(true);
    expect(hasSideConversations(bot("main", one))).toBe(false);
  });

  it("leaves the header exactly as it was for a bot with one conversation", () => {
    show(pill(bot("main", one)));
    expect(host.querySelector("[data-chathead-crumb]")).toBeNull();
    expect(host.querySelector("[data-chathead-conversation]")).toBeNull();
    expect(host.querySelectorAll("button")).toHaveLength(1);
  });

  it("names the main chat in the crumb once the bot has another conversation", () => {
    show(pill(bot("main", two)));
    expect(host.querySelector("[data-chathead-conversation]")!.textContent).toBe("Main chat");
  });

  it("names a side conversation by its title, and an untitled one as a conversation", () => {
    show(pill(bot("older", two)));
    expect(host.querySelector("[data-chathead-conversation]")!.textContent).toBe("Quarter numbers");
    show(pill(bot("fresh", two)));
    expect(host.querySelector("[data-chathead-conversation]")!.textContent).toBe("New conversation");
  });

  it("opens a switcher from the crumb with main first and New conversation last, and switches on a click", () => {
    show(pill(bot("main", two)));
    click(host.querySelector("[data-chathead-crumb]"));
    const menu = host.querySelector("[data-conversation-switcher]")!;
    expect([...menu.querySelectorAll("[data-conversation]")].map((row) => row.getAttribute("data-conversation"))).toEqual(["main", "fresh", "older"]);
    expect(menu.querySelector("[data-conversation=main] time")!.textContent).toBe("5 min ago");
    const items = [...menu.querySelectorAll("[role=menuitem]")];
    expect(items.at(-1)!.textContent).toBe("New conversation");
    click(menu.querySelector("[data-conversation=older] [data-conversation-open]"));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "pepper", threadId: "older" });
  });

  it("starts a new conversation from the bottom of the switcher", () => {
    show(pill(bot("main", two)));
    click(host.querySelector("[data-chathead-crumb]"));
    click(host.querySelector("[data-conversation-new]"));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "newTask", botId: "pepper" });
  });

  it("makes a conversation main from its row, and offers that only on rows that are not main", () => {
    show(pill(bot("main", two)));
    click(host.querySelector("[data-chathead-crumb]"));
    expect(host.querySelector("[data-conversation=main] [data-conversation-set-main]")).toBeNull();
    click(host.querySelector("[data-conversation=older] [data-conversation-set-main]"));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "pepper", patch: { mainThreadChoice: "older" } });
  });

  it("closes on Escape", () => {
    show(pill(bot("main", two)));
    click(host.querySelector("[data-chathead-crumb]"));
    const menu = host.querySelector("[data-conversation-switcher]")!;
    flushSync(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector("[aria-expanded=true][data-chathead-crumb]")).toBeNull();
  });
});

describe("the bot panel's conversations", () => {
  it("shows nothing for a bot with one conversation", () => {
    show(createElement(ConversationsCard, { bot: bot("main", one) }));
    expect(host.querySelector("[data-panel-card]")).toBeNull();
  });

  it("lists the same rows once there are two", () => {
    show(createElement(ConversationsCard, { bot: bot("main", two) }));
    expect([...host.querySelectorAll("[data-conversation]")].map((row) => row.getAttribute("data-conversation"))).toEqual(["main", "fresh", "older"]);
    click(host.querySelector("[data-conversation=fresh] [data-conversation-open]"));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "pepper", threadId: "fresh" });
  });
});
