// @vitest-environment happy-dom
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { CameraScanner, CameraSession, MobilePlatform } from "../platform";

vi.mock("motion/react", async (original) => {
  const actual = await original<typeof import("motion/react")>();
  const strip = ({ initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown>) => rest;
  const motion = new Proxy({}, { get: (_, tag: string) => (props: Record<string, unknown>) => createElement(tag, strip(props)) });
  return { ...actual, motion, AnimatePresence: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children), useReducedMotion: () => true };
});
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
vi.mock("../haptics", () => ({ haptic: vi.fn() }));

import { Scanner } from "./Scanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

type Start = Parameters<CameraScanner["start"]>[0];

/** A fake native scanner: what the page asked to start with, and what it has stopped. */
function fakePlatform(options: { kind?: MobilePlatform["kind"]; fullScreen?: boolean; startError?: Error; permission?: "granted" | "denied" | "prompt" } = {}) {
  const stop = vi.fn(async () => {});
  let started: Start | undefined;
  const pauses: Array<() => void> = [];
  const backs: Array<() => boolean> = [];
  const camera: CameraScanner = {
    permission: vi.fn(async () => options.permission ?? "granted"),
    request: vi.fn(async () => "granted" as const),
    start: vi.fn(async (args: Start) => {
      started = args;
      if (options.startError) throw options.startError;
      return { stop, fullScreen: options.fullScreen } satisfies CameraSession;
    }),
  };
  const platform = {
    kind: options.kind ?? "android",
    camera,
    onPause: (listener: () => void) => { pauses.push(listener); return () => { pauses.splice(pauses.indexOf(listener), 1); }; },
    onBack: (listener: () => boolean) => { backs.push(listener); return () => { backs.splice(backs.indexOf(listener), 1); }; },
  } as unknown as MobilePlatform;
  return { platform, camera, stop, started: () => started, pauses, backs };
}

function handlers() {
  return { onCode: vi.fn(), onClose: vi.fn(), onEnterCode: vi.fn(), onPaste: vi.fn(), onDenied: vi.fn() };
}

async function render(platform: MobilePlatform, on: ReturnType<typeof handlers>) {
  await act(async () => { root.render(createElement(Scanner, { platform, busy: false, ...on })); });
}

/** the scanner waits for the previous session's close (plus a beat) before it starts the next */
async function until(check: () => boolean) {
  for (let tries = 0; tries < 100 && !check(); tries += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  expect(check()).toBe(true);
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("pairing scanner lifecycle", () => {
  it("the close button stops the camera before the screen goes, and unmounting does not stop it twice", async () => {
    const fake = fakePlatform();
    const on = handlers();
    await render(fake.platform, on);
    await until(() => Boolean(fake.started()));
    await act(async () => { await Promise.resolve(); });

    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(close).not.toBeNull();
    await act(async () => { close!.click(); });
    expect(on.onClose).toHaveBeenCalledTimes(1);
    await until(() => fake.stop.mock.calls.length === 1);

    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["close", "onClose"],
    ["code", "onEnterCode"],
    ["paste", "onPaste"],
  ] as const)("the full screen scanner's %s button stops the camera while the page is still mounted", async (key, handler) => {
    const fake = fakePlatform({ kind: "ios", fullScreen: true });
    const on = handlers();
    await render(fake.platform, on);
    await until(() => Boolean(fake.started()));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { fake.started()!.onAction?.(key); });
    expect(on[handler]).toHaveBeenCalledTimes(1);
    // still mounted: an exit animation that never ends must not hold the camera open
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await until(() => fake.stop.mock.calls.length === 1);

    await act(async () => { fake.started()!.onAction?.("close"); });
    expect(on.onClose).toHaveBeenCalledTimes(handler === "onClose" ? 1 : 0);
  });

  it("going to the background closes the scanner and stops the camera", async () => {
    const fake = fakePlatform();
    const on = handlers();
    await render(fake.platform, on);
    await until(() => Boolean(fake.started()));
    expect(fake.pauses).toHaveLength(1);

    await act(async () => { fake.pauses[0]!(); });
    expect(on.onClose).toHaveBeenCalledTimes(1);
    await until(() => fake.stop.mock.calls.length === 1);
  });

  it("android back closes the scanner first, before the screen under it", async () => {
    const fake = fakePlatform();
    const on = handlers();
    const under = vi.fn(() => true);
    fake.backs.push(under);
    await render(fake.platform, on);
    await until(() => Boolean(fake.started()));

    const newest = fake.backs.at(-1)!;
    expect(newest).not.toBe(under);
    let taken = false;
    await act(async () => { taken = newest(); });
    expect(taken).toBe(true);
    expect(under).not.toHaveBeenCalled();
    expect(on.onClose).toHaveBeenCalledTimes(1);
    await until(() => fake.stop.mock.calls.length === 1);

    await act(async () => { root.unmount(); });
    root = createRoot(host);
    expect(fake.backs).toEqual([under]);
    expect(fake.pauses).toEqual([]);
  });

  it("a camera refused in Settings closes the scanner and says so instead of claiming there is no camera", async () => {
    const fake = fakePlatform({ startError: new Error("camera permission was not granted"), permission: "denied" });
    const on = handlers();
    await render(fake.platform, on);
    await until(() => on.onDenied.mock.calls.length === 1);
    expect(on.onClose).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("No camera here");
  });

  it("a camera that fails for another reason stays on screen with the way to type the code", async () => {
    const fake = fakePlatform({ startError: new Error("this device has no camera to scan with"), permission: "granted" });
    const on = handlers();
    await render(fake.platform, on);
    await until(() => host.textContent?.includes("No camera here") ?? false);
    expect(on.onDenied).not.toHaveBeenCalled();
    expect(host.querySelector('button[aria-label="Close"]')).not.toBeNull();
  });
});
