// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const changelog = vi.hoisted(() => ({ releases: [] as unknown[] }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async (path: string) => {
    if (path === "/api/updates/changelog") return { v: 1, releases: changelog.releases };
    throw new Error(`unexpected ${path}`);
  }),
}));

import { CLOUD_NOTICE, WHATS_NEW_NOTICE, launchNotice, markLaunchNotice } from "@/lib/notices";
import { resetLaunchesForTests, resetReleasesForTests } from "@/lib/release-notes";
import { UpdatedDialog, resetUpdatedDialogForTests } from "./UpdatedDialog";
import { WhatsNewRow } from "./SettingsPanes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (text: string, kind: string, area = "desktop") => ({ text, area, kind });
const RELEASE_32 = {
  version: "0.2.32", date: "2026-11-27", title: "Fresh chats",
  items: [
    item("A sleeping dusk cloud says Waking and opens on its own.", "better"),
    item("Type /new for a clean chat, or /compact to shorten a long one.", "new", "all"),
    item("Phone alerts arrive, and your phone tells you if they can't.", "fixed", "all"),
    item("Attach a .zip and your bot reads every file in it.", "new", "all"),
    item("iPhone photos arrive as pictures.", "new", "all"),
    item("Claude stays signed in when its login renews.", "fixed", "server"),
    item("The phone's QR scanner always closes.", "fixed", "phone"),
  ],
};
const RELEASE_31 = { version: "0.2.31", date: "2026-11-25", items: [item("Bots sound like a person.", "better", "all")] };

let saved: Map<string, string>;
let host: HTMLDivElement, root: Root;
const seen = vi.fn();

function launch(version: string) {
  resetLaunchesForTests();
  resetReleasesForTests();
  resetUpdatedDialogForTests();
  sessionStorage.clear();
  (window as unknown as { duskDesktop: unknown }).duskDesktop = { app: { version } };
}

async function mount(updated: string | null) {
  await act(async () => { root.render(createElement(UpdatedDialog, { updated, seen })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const dialog = () => document.querySelector<HTMLElement>("[data-whats-new]");

beforeEach(() => {
  saved = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
  changelog.releases = [RELEASE_32, RELEASE_31];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function firstRun(version = "0.2.31") {
  launch(version);
  await mount(null);
  act(() => root.unmount());
  root = createRoot(host);
}

describe("What's new after an update", () => {
  it("opens once for the new version, says plainly it is an update, and not again next launch", async () => {
    await firstRun();
    launch("0.2.32");
    await mount("0.2.32");
    expect(seen).toHaveBeenCalled();
    const shown = dialog();
    expect(shown).not.toBeNull();
    expect(shown!.hasAttribute("data-whats-new-updated")).toBe(true);
    expect(shown!.textContent).toContain("Updated to 0.2.32");
    expect(shown!.textContent).toContain("Here's what's new");
    expect([...shown!.querySelectorAll("[data-change-kind]")].map((group) => group.getAttribute("data-change-kind"))).toEqual(["new", "better", "fixed"]);
    expect(shown!.textContent).not.toContain("QR scanner");
    expect(shown!.textContent).not.toContain("Bots sound like a person");
    expect(launchNotice()).toBe(WHATS_NEW_NOTICE);

    await act(async () => { shown!.querySelector<HTMLButtonElement>("[data-whats-new-done]")!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(dialog()).toBeNull();

    act(() => root.unmount());
    root = createRoot(host);
    launch("0.2.32");
    await mount(null);
    expect(dialog()).toBeNull();
    await mount("0.2.32");
    expect(dialog()).toBeNull();
  });

  it("shows the first five changes and the rest in place on See all", async () => {
    await firstRun();
    launch("0.2.32");
    await mount("0.2.32");
    const shown = dialog()!;
    expect(shown.querySelectorAll("li")).toHaveLength(5);
    const all = shown.querySelector<HTMLButtonElement>("[data-whats-new-all]")!;
    expect(all.textContent).toBe("See all 6 changes");
    await act(async () => { all.click(); });
    expect(shown.querySelectorAll("li")).toHaveLength(6);
    expect(shown.querySelector("[data-whats-new-all]")).toBeNull();
  });

  it("never shows on a fresh install", async () => {
    launch("0.2.32");
    await mount(null);
    expect(dialog()).toBeNull();
  });

  it("shows nothing when the changelog has no notes for the new version", async () => {
    changelog.releases = [RELEASE_31];
    await firstRun();
    launch("0.2.32");
    await mount("0.2.32");
    expect(dialog()).toBeNull();
    expect(launchNotice()).toBeNull();
  });

  it("waits for the next launch when another popup took this one", async () => {
    await firstRun();
    launch("0.2.32");
    markLaunchNotice(CLOUD_NOTICE);
    await mount("0.2.32");
    expect(dialog()).toBeNull();

    act(() => root.unmount());
    root = createRoot(host);
    launch("0.2.32");
    await mount(null);
    expect(dialog()?.textContent).toContain("Updated to 0.2.32");
  });
});

describe("Settings > What's new", () => {
  it("opens the same dialog for this version, as a version rather than an update", async () => {
    launch("0.2.32");
    await act(async () => { root.render(createElement(WhatsNewRow)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const row = host.querySelector<HTMLElement>("[data-settings-open='whats-new']");
    expect(row).not.toBeNull();
    await act(async () => { (row!.closest("button") ?? row!).click(); });
    const shown = dialog();
    expect(shown?.textContent).toContain("Version 0.2.32");
    expect(shown?.textContent).toContain("What's new");
    expect(shown?.hasAttribute("data-whats-new-updated")).toBe(false);
    expect(shown?.querySelectorAll("li")).toHaveLength(5);
  });
});
