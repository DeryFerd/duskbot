import { describe, expect, it, vi } from "vitest";
import { createNotificationTaps, fromBotHost } from "./notification-taps";
import { phoneActionFrom, type NativeAction } from "./phone-actions";

/** Capacitor's plugin events: one fired with no listener is kept and handed to the first listener added, only. */
function capacitorEvent() {
  const listeners: Array<(event: NativeAction) => void> = [];
  let retained: NativeAction[] = [];
  return {
    fire(event: NativeAction) {
      if (!listeners.length) { retained.push(event); return; }
      for (const listener of listeners) listener(event);
    },
    addListener(listener: (event: NativeAction) => void) {
      listeners.push(listener);
      if (listeners.length === 1) { const kept = retained; retained = []; for (const event of kept) listener(event); }
    },
  };
}

const androidTap: NativeAction = { actionId: "tap", data: { kind: "done", botId: "bot-1", threadId: "thread-1", id: "n1" } };
const iosTap: NativeAction = { actionId: "tap", data: { aps: {}, dusk: { kind: "done", botId: "bot-2", threadId: "thread-2", id: "n2" } } };

describe("notification taps", () => {
  it("opens the bot's chat from a tap that cold-started the app, on Android's flat data and the iPhone's block", () => {
    for (const tap of [androidTap, iosTap]) {
      const native = capacitorEvent();
      const taps = createNotificationTaps();
      native.fire(tap);
      native.addListener(taps.feed);
      const opened = vi.fn();
      // the page listens for older links' taps first, as the app does
      taps.onOpen(opened);
      const actions: NativeAction[] = [];
      taps.onAction((action) => actions.push(action));
      expect(opened).not.toHaveBeenCalled();
      expect(actions.map(phoneActionFrom)).toEqual([{ kind: "open", target: { threadId: tap === androidTap ? "thread-1" : "thread-2", botId: tap === androidTap ? "bot-1" : "bot-2" } }]);
    }
  });

  it("hands a warm tap to the listener at once and an older link's tap to the open listener", () => {
    const taps = createNotificationTaps();
    const opened = vi.fn();
    const acted = vi.fn();
    taps.onOpen(opened);
    taps.onAction(acted);
    taps.feed(androidTap);
    taps.feed({ actionId: "tap", data: { bot: "bot-9", thread: "thread-9" } });
    expect(acted).toHaveBeenCalledExactlyOnceWith(androidTap);
    expect(opened).toHaveBeenCalledExactlyOnceWith({ botId: "bot-9", threadId: "thread-9" });
  });

  it("tells a bot host push from an older link's", () => {
    expect(fromBotHost(androidTap.data)).toBe(true);
    expect(fromBotHost(iosTap.data)).toBe(true);
    expect(fromBotHost({ omb: { threadId: "t" } })).toBe(true);
    expect(fromBotHost({ bot: "b", thread: "t" })).toBe(false);
    expect(fromBotHost({ threadId: "t", botId: "b" })).toBe(false);
  });
});
