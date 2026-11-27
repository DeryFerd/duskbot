// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consent = vi.hoisted(() => ({ value: null as null | { consent: unknown; asking: boolean } }));
vi.mock("./consent/AiConsent", () => ({ useAiConsent: () => consent.value }));
vi.mock("./platform", () => ({ usePlatform: () => ({ appVersion: "1.2.13", native: true }) }));
const launch = vi.hoisted(() => ({ updated: true as boolean, newest: "0.2.35" }));
vi.mock("@/lib/release-notes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/release-notes")>(),
  updatedThisLaunch: () => launch.updated,
  loadReleases: async () => [launch.newest, "0.2.34", "0.2.33", "0.2.32"].map((version) => ({ version, date: "2026-11-27", items: [{ text: `Phone line ${version}`, area: "phone", kind: "fixed" }] })),
}));
vi.mock("./sheets/UpdatesPage", () => ({ WhatsNewPage: ({ notes }: { notes: { items: { text: string }[] }[] }) => createElement("div", { "data-whats-new-sheet": "" }, notes.flatMap((release) => release.items.map((item) => item.text)).join("|")) }));

import { PhoneUpdatedLine } from "./PhoneUpdatedLine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, saved: Map<string, string>;
const sheet = () => document.querySelector("[data-whats-new-sheet]");
async function render() {
  await act(async () => { root.render(createElement(PhoneUpdatedLine)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  saved = new Map();
  launch.updated = true;
  launch.newest = "0.2.35";
  saved.set("dusk-whats-new:phone-release", "0.2.32");
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), removeItem: (key: string) => void saved.delete(key) });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const allowed = () => { consent.value = { consent: { answer: "allowed", at: 1, providers: [] }, asking: false }; };
const reopen = () => { act(() => root.unmount()); root = createRoot(host); };

describe("PhoneUpdatedLine on every 5th version", () => {
  it("shows nothing for releases that are not a multiple of 5", async () => {
    allowed();
    launch.newest = "0.2.34";
    await render();
    expect(sheet()).toBeNull();
  });

  it("opens one sheet at 0.2.35 with every line since the last release it showed, then not again", async () => {
    allowed();
    await render();
    expect(sheet()?.textContent).toBe("Phone line 0.2.35|Phone line 0.2.34|Phone line 0.2.33");
    reopen();
    launch.updated = false;
    await render();
    expect(sheet()).toBeNull();
  });

  it("shows nothing when the phone did not update, even if a release is out", async () => {
    allowed();
    launch.updated = false;
    await render();
    expect(sheet()).toBeNull();
  });

  it("shows nothing on a fresh install", async () => {
    allowed();
    saved.delete("dusk-whats-new:phone-release");
    await render();
    expect(sheet()).toBeNull();
  });
});

describe("PhoneUpdatedLine", () => {
  it("waits while Before you chat is open, and opens once it is answered", async () => {
    consent.value = { consent: null, asking: true };
    await render();
    expect(sheet()).toBeNull();
    consent.value = { consent: { answer: "allowed", at: 1, providers: [] }, asking: false };
    await render();
    expect(sheet()).not.toBeNull();
  });

  it("waits for an answer even before the question has come up", async () => {
    consent.value = { consent: null, asking: false };
    await render();
    expect(sheet()).toBeNull();
  });

  it("opens at once when the question was answered before", async () => {
    consent.value = { consent: { answer: "allowed", at: 1, providers: [] }, asking: false };
    await render();
    expect(sheet()).not.toBeNull();
  });
});
