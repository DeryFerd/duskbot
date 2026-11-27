// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consent = vi.hoisted(() => ({ value: null as null | { consent: unknown; asking: boolean } }));
vi.mock("./consent/AiConsent", () => ({ useAiConsent: () => consent.value }));
vi.mock("./platform", () => ({ usePlatform: () => ({ appVersion: "1.2.13", native: true }) }));
vi.mock("@/lib/release-notes", () => ({
  PHONE_AREAS: ["all", "phone"],
  updatedThisLaunch: () => true,
  loadReleases: async () => [{ version: "0.2.32", date: "2026-11-27", items: [{ text: "The phone's QR scanner always closes.", area: "phone", kind: "fixed" }] }],
  notesForUpdate: (all: unknown[]) => all,
}));
vi.mock("./sheets/UpdatesPage", () => ({ WhatsNewPage: () => createElement("div", { "data-whats-new-sheet": "" }) }));

import { PhoneUpdatedLine } from "./PhoneUpdatedLine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const sheet = () => document.querySelector("[data-whats-new-sheet]");
async function render() {
  await act(async () => { root.render(createElement(PhoneUpdatedLine)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

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
