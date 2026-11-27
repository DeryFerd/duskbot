import { describe, expect, it, vi } from "vitest";

import { dialogAnswerOf, dialogNote, DialogWatch, localDevToolsUrl, withoutDialogAnswer, withoutDialogWarning } from "./browser-dialogs.ts";
import type { Cdp, CdpListeners } from "./browser-sites.ts";

async function watching() {
  let listeners: CdpListeners = {};
  const cdp: Cdp = { send: vi.fn(async () => ({})), close: vi.fn() };
  const changes: unknown[] = [];
  const watch = new DialogWatch((dialog) => changes.push(dialog));
  await watch.start("ws://127.0.0.1:9222/devtools/browser/x", async (_url, _timeout, given) => { listeners = given; return cdp; });
  const emit = (method: string, params: Record<string, unknown>, sessionId?: string) => listeners.event?.({ method, params, sessionId });
  return { watch, cdp, changes, emit, closed: () => listeners.closed?.() };
}

describe("a browser's page dialogs", () => {
  it("connects only to the engine's own Chrome on this machine", () => {
    expect(localDevToolsUrl("ws://127.0.0.1:9222/devtools/browser/ab-12")).toBe("ws://127.0.0.1:9222/devtools/browser/ab-12");
    for (const url of ["ws://browser.example.net:9222/devtools/browser/x", "ws://127.0.0.1:9222/devtools/page/x", "http://127.0.0.1:9222/json", 9222, null]) {
      expect(localDevToolsUrl(url)).toBeNull();
    }
  });

  it("tracks a confirm or prompt, never the alerts the engine answers itself, until it closes or its page goes", async () => {
    const { watch, changes, emit } = await watching();
    emit("Page.javascriptDialogOpening", { type: "alert", message: "Hi" }, "page-1");
    emit("Page.javascriptDialogOpening", { type: "beforeunload", message: "" }, "page-1");
    expect(watch.dialog).toBeNull();
    emit("Page.javascriptDialogOpening", { type: "prompt", message: "Name?", defaultPrompt: "Ada" }, "page-1");
    expect(watch.dialog).toEqual({ type: "prompt", message: "Name?", defaultValue: "Ada" });
    emit("Page.javascriptDialogClosed", {}, "page-2");
    expect(watch.dialog).not.toBeNull();
    emit("Target.detachedFromTarget", { sessionId: "page-1" });
    expect(watch.dialog).toBeNull();
    expect(changes).toEqual([{ type: "prompt", message: "Name?", defaultValue: "Ada" }, null]);
    expect(watch.opened).toBe(1);
  });

  it("answers on the page that asked, and only while it asks", async () => {
    const { watch, cdp, emit } = await watching();
    expect(await watch.answer(true)).toBe(false);
    emit("Page.javascriptDialogOpening", { type: "confirm", message: "Leave?" }, "page-1");
    const settled = watch.settled();
    expect(await watch.answer(true, "ignored for a confirm")).toBe(true);
    expect(cdp.send).toHaveBeenLastCalledWith("Page.handleJavaScriptDialog", { accept: true }, "page-1");
    await settled;
    expect(watch.dialog).toBeNull();
  });

  it("stops waiting when its view goes or its connection closes", async () => {
    const { watch, emit, closed } = await watching();
    emit("Page.javascriptDialogOpening", { type: "confirm", message: "Leave?" }, "page-1");
    const view = new AbortController();
    const waiting = watch.settled(view.signal);
    view.abort();
    await waiting;
    const pending = watch.settled();
    closed();
    await pending;
    expect(watch.closed).toBe(true);
  });
});

describe("a page question a bot call brought up", () => {
  it("is answered Cancel unless the call said accept, and the answer never reaches the engine", () => {
    expect(dialogAnswerOf({ name: "agent_browser_click", arguments: { selector: "#delete" } })).toEqual({ accept: false });
    expect(dialogAnswerOf({ arguments: { selector: "#name", dialog: "accept", promptText: "Ada" } })).toEqual({ accept: true, promptText: "Ada" });
    expect(withoutDialogAnswer({ name: "agent_browser_click", arguments: { selector: "#c", dialog: "accept" } })).toEqual({ name: "agent_browser_click", arguments: { selector: "#c" } });
  });

  it("tells the bot what was asked and how to say yes, without agent-browser's warning about a tool it does not offer", () => {
    const dialog = { type: "confirm" as const, message: "sure?", defaultValue: "" };
    expect(dialogNote(dialog, { accept: false })).toBe('The page asked "sure?" (a confirm dialog) and dusk bot answered Cancel so the page would not stay stuck, so it did not get a yes. To answer OK instead, make this same call again with "dialog": "accept".');
    expect(dialogNote(dialog, { accept: true })).toBe('The page asked "sure?" (a confirm dialog) and dusk bot answered OK, as this call asked.');
    const answered = { content: [{ type: "text", text: JSON.stringify({ data: { clicked: "#c", dialogOpened: true }, success: true, warning: "A JavaScript confirm dialog is blocking the page: \"sure?\" — answer it with agent_browser_dialog (accept true or false)" }) }] };
    expect(JSON.parse((withoutDialogWarning(answered) as typeof answered).content[0]!.text)).toEqual({ data: { clicked: "#c", dialogOpened: true }, success: true });
  });
});
