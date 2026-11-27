// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StoreContext, type Bot, type InstanceInfo, type Message } from "@/state/store";
import type { FirstReplyRescue } from "../../shared/first-reply-rescue";
import { PERSON_STOPPED_TURN_NAME, STOPPED_TURN_NAME } from "../../shared/client-cancel";
import { CancelledTurnRow } from "./CancelledTurnRow";
import { StatusActivityRow } from "./StatusActivityRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rescue: FirstReplyRescue = { botId: "bot-1", threadId: "thread-1", turnId: "turn-1", requestMessageId: "ask-1", instanceId: "opencodeGo", ai: "OpenCode" };
const AT = 50_000;
const row = (payload: FirstReplyRescue = rescue): Message => ({
  id: "m-1", at: AT, role: "bot", kind: "activity", turnId: payload.turnId,
  tool: { name: payload.over ? "notice: Maus didn't hear back from OpenCode." : "notice: Maus hasn't heard back from OpenCode yet.", ok: true, rescue: payload },
} as Message);
const bot = (busy: boolean): Bot => ({
  id: "bot-1", threadId: "thread-1", name: "Maus", title: "", description: "", notifications: true, color: "green", unread: false, busy,
  messages: [{ id: "ask-1", at: 1, role: "user", kind: "text", text: "Plan my week" }],
  modelSelection: { instanceId: "opencodeGo", model: "free" }, tasks: [{ threadId: "thread-1", title: "Chat", createdAt: 1, busy }],
} as unknown as Bot);
const engine = { instanceId: "opencodeGo", displayName: "OpenCode", driverKind: "opencodeGo", models: { default: "free", options: [] } } as unknown as InstanceInfo;

let host: HTMLDivElement;
let root: Root;
function render(message: Message, options: { busy?: boolean } = {}) {
  const value = { state: { bots: [bot(options.busy ?? true)], instances: [engine], groups: [] }, dispatch: () => {} } as never;
  act(() => root.render(createElement(StoreContext.Provider, { value }, createElement(StatusActivityRow, { message }))));
}
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent === label);

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("first-reply rescue row", () => {
  it("leaves the wait out of the chat: the working line says the bot is at work", () => {
    render(row());
    expect(host.textContent).toBe("");
    expect(host.querySelector("button")).toBeNull();
  });

  it("leaves an ended turn's notice out of the chat too: the card above the composer says it", () => {
    render(row({ ...rescue, over: true }), { busy: false });
    expect(host.textContent).toBe("");
  });
});

describe("stopped row", () => {
  it("says one quiet word, whoever stopped it", () => {
    act(() => root.render(createElement(CancelledTurnRow, { name: PERSON_STOPPED_TURN_NAME })));
    expect(host.textContent).toBe("Stopped");
    expect(host.querySelector('[role="status"][data-event-line]')).not.toBeNull();
    act(() => root.render(createElement(CancelledTurnRow, { name: STOPPED_TURN_NAME })));
    expect(host.textContent).toBe("Stopped");
  });
});

describe("a notice that signing in fixes", () => {
  const notice = (name: string, setup?: true): Message => ({ id: "m-2", at: AT, role: "bot", kind: "activity", tool: { name, ok: true, ...(setup ? { setup } : {}) } } as Message);

  it("leaves a sign-out something has since followed out of the chat, and draws any other notice as one quiet line", () => {
    // while it is the newest thing, the card above the composer says it with its Sign in (GroupView.failed-turn.test.ts)
    render(notice("notice: Claude is signed out on the Cloud. Sign in again in Settings → Models to keep using it.", true));
    expect(host.textContent).toBe("");
    render(notice("notice: continuing on Codex while Claude is signed out"));
    expect(host.querySelector("[role=status]")).not.toBeNull();
    expect(host.querySelector("[data-chat-error]")).toBeNull();
    expect(host.textContent).toContain("continuing on Codex while Claude is signed out");
    expect(button("sign in")).toBeUndefined();
  });
});

describe("a notice that asks for an AI", () => {
  it("is one short line with Sign in beside it", () => {
    render({ id: "m-2", at: AT, role: "bot", kind: "activity", tool: { name: "notice: Routines are paused. Sign in to your AI to turn them back on.", ok: true, signIn: true } } as Message, { busy: false });
    expect(host.textContent).toBe("Routines are paused. Sign in to your AI to turn them back on.Sign in");
    expect(button("Sign in")?.type).toBe("button");
  });

  it("offers nothing beside a notice that asks for no sign-in", () => {
    render({ id: "m-3", at: AT, role: "bot", kind: "activity", tool: { name: "notice: Paused because the plan was cancelled.", ok: true } } as Message, { busy: false });
    expect(button("Sign in")).toBeUndefined();
  });
});
