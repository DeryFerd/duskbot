// @vitest-environment happy-dom
import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBottomFollowResize } from "./bottom-follow";

let watchers: Array<{ fire: () => void; watched: Element[] }> = [];
let host: HTMLDivElement, root: Root;
let content = 2000, view = 700;

beforeEach(() => {
  watchers = [];
  vi.stubGlobal("ResizeObserver", class {
    watched: Element[] = [];
    constructor(private readonly callback: () => void) { watchers.push({ fire: () => this.callback(), watched: this.watched }); }
    observe(el: Element) { this.watched.push(el); }
    disconnect() {}
  });
  content = 2000;
  view = 700;
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function Chat({ following }: { following: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(following);
  useBottomFollowResize(scrollRef, transcriptRef, followingRef, "thread");
  return createElement("div", { ref: scrollRef, id: "scroller" }, createElement("div", { ref: transcriptRef, id: "transcript" }));
}

function mount(following: boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(Chat, { following })));
  const scroller = document.getElementById("scroller")!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => content });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => view });
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, content - view)); } });
  scroller.scrollTo = ((options: ScrollToOptions) => { scroller.scrollTop = options.top ?? top; }) as typeof scroller.scrollTo;
  scroller.scrollTop = content - view;
  return scroller;
}

/** what a resize of `el` tells the observers watching it */
const resized = (el: Element) => { for (const w of watchers) if (w.watched.includes(el)) w.fire(); };

describe("a transcript resting at its end", () => {
  it("stays there when its view gets shorter, as when a phone's bottom inset lands after the chat opened", () => {
    const scroller = mount(true);
    expect(scroller.scrollTop).toBe(1300);
    view = 666;
    resized(scroller);
    expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBe(0);
  });

  it("leaves a transcript scrolled back where it was", () => {
    const scroller = mount(false);
    scroller.scrollTop = 400;
    view = 666;
    resized(scroller);
    expect(scroller.scrollTop).toBe(400);
  });
});
