// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AppUpdateState } from "../../electron/app-update.mjs";
import { AppVersionRow } from "./AppVersionRow";
import { SidebarSpot } from "./SidebarSpot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tell: (state: AppUpdateState) => void = () => {};
let now: AppUpdateState;
let found: string | null;
const bridge = {
  state: vi.fn(async () => now),
  restart: vi.fn(async () => true),
  download: vi.fn(async () => found),
  seen: vi.fn(async () => {}),
  open: vi.fn(async () => true),
  move: vi.fn(async () => true),
  onState: vi.fn((cb: (state: AppUpdateState) => void) => { tell = cb; return () => {}; }),
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  now = { ready: null, available: null, progress: null, mode: "self" };
  found = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); });

const row = () => host.querySelector<HTMLButtonElement>("[data-settings-open='app-update']");
const mount = async () => { await act(async () => { root.render(createElement(AppVersionRow, { bridge, fallback: createElement("p", { "data-fallback": "" }) })); }); };
const hear = async (state: AppUpdateState) => { await act(async () => { tell(state); }); };

it("a check always answers: checking, then the latest", async () => {
  await mount();
  expect(row()?.textContent).toContain("Check for updates");
  let finish: (v: string | null) => void = () => {};
  bridge.download.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { row()?.click(); });
  expect(row()?.textContent).toContain("Checking…");
  expect(row()?.disabled).toBe(true);
  await hear({ ...now, checking: false, failed: false });
  await act(async () => { finish(null); });
  expect(row()?.textContent).toContain("You're on the latest version");
});

it("a failed check says so", async () => {
  await mount();
  await act(async () => { row()?.click(); });
  await hear({ ...now, checking: false, failed: true });
  expect(row()?.textContent).toContain("Couldn't check for updates");
});

it("a found update downloads, then offers the restart", async () => {
  await mount();
  await hear({ ...now, available: "0.2.13", progress: 0.4, checking: true });
  expect(row()?.textContent).toContain("Downloading 0.2.13 · 40%");
  await hear({ ...now, ready: "0.2.13", available: "0.2.13", progress: null });
  expect(row()?.textContent).toContain("Restart to update");
  await act(async () => { row()?.click(); });
  expect(bridge.restart).toHaveBeenCalledOnce();
});

it("a source checkout says it's a dev build, with nothing to check", async () => {
  now = { ready: null, mode: "dev" };
  await mount();
  expect(row()).toBeNull();
  expect(host.textContent).toContain("dev build");
  expect(host.textContent).toContain("updates when the checkout does");
});

it("Windows and Linux keep the server's row", async () => {
  now = { ready: null, mode: "notice" };
  await mount();
  expect(host.querySelector("[data-fallback]")).not.toBeNull();
});

it("the sidebar shows no line after the app updated, and marks it seen", async () => {
  now = { ready: null, mode: "self", updated: "0.2.13" };
  await act(async () => { root.render(createElement(SidebarSpot, { bridge })); });
  expect(host.textContent).not.toContain("0.2.13");
  expect(bridge.seen).toHaveBeenCalledOnce();
});

it("uses the linked workspace even when an older Mac bridge also offers app updates", async () => {
  vi.stubGlobal("duskDesktop", { app: { ownPage: false }, appUpdate: bridge });
  try {
    await act(async () => { root.render(createElement(AppVersionRow, { fallback: createElement("p", { "data-fallback": "" }) })); });
    expect(host.querySelector("[data-fallback]")).not.toBeNull();
    expect(bridge.state).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it("an update the app can't install itself offers the download, never the latest version", async () => {
  await mount();
  await hear({ ...now, available: "0.2.32", manual: { version: "0.2.32", url: "https://dusk.bot/download" } });
  expect(row()?.textContent).toContain("Download 0.2.32");
  expect(row()?.textContent).not.toContain("latest");
  await act(async () => { row()?.click(); });
  expect(bridge.open).toHaveBeenCalledTimes(1);
  expect(bridge.download).not.toHaveBeenCalled();
});

it("an app run from Downloads offers Move to Applications", async () => {
  await mount();
  await hear({ ...now, available: "0.2.32", blocked: "move" });
  expect(row()?.textContent).toContain("Move to Applications");
  await act(async () => { row()?.click(); });
  expect(bridge.move).toHaveBeenCalledTimes(1);
});

it("a dropped download says it is retrying", async () => {
  await mount();
  await hear({ ...now, available: "0.2.32", progress: 0.3, retrying: true });
  expect(row()?.textContent).toContain("Retrying download");
});
