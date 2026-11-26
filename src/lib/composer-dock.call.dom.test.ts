// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { dockClearance } from "./composer-dock";

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

function chat(call?: { height: number; leaving?: boolean; full?: boolean }) {
  const main = document.createElement("main");
  const heights = new Map<Element, number>();
  if (call) {
    const bar = document.createElement("div");
    bar.setAttribute("data-call-surface", "");
    if (!call.full) bar.className = "voice-call-dock";
    main.append(bar);
    heights.set(bar, call.height);
  }
  const frame = document.createElement("div");
  const dock = document.createElement("div");
  frame.append(dock);
  main.append(frame);
  heights.set(dock, 96);
  document.body.append(main);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return { height: heights.get(this) ?? 0 } as DOMRect;
  });
  return dock;
}

describe("the transcript's end clearance", () => {
  it("is the composer's dock with no call", () => {
    expect(dockClearance(chat())).toBe(96);
  });

  it("is a call's bar when it stands taller than the composer, so the bot's working line is not drawn under it", () => {
    expect(dockClearance(chat({ height: 136 }))).toBe(136);
  });

  it("stays the composer's when the call's bar is the shorter one", () => {
    expect(dockClearance(chat({ height: 60 }))).toBe(96);
  });

  it("ignores a call that covers the whole chat", () => {
    expect(dockClearance(chat({ height: 800, full: true }))).toBe(96);
  });
});
