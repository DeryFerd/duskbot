// @vitest-environment happy-dom
// the update cards sit in the home list and push it down: never a fixed layer over the top bar's buttons
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { PlatformContext, type MobilePlatform } from "../platform";
import { PhoneUpdateLine } from "./PhoneUpdateLine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
setLocale("en");
const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key), clear: () => stored.clear() } });

const android = { kind: "android", native: true, appVersion: "1.2.9", openExternal: vi.fn(async () => {}) } as unknown as MobilePlatform;

async function show(answers: { old: boolean; apk: boolean }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/.well-known/duskbot/environment") return Response.json({ capabilities: { api: 1, minMobile: answers.old ? 99 : 1 } });
    if (url.startsWith("https://dusk.bot/releases/latest.json")) return Response.json({ v: 1, version: "0.2.31", ...(answers.apk ? { android: { version: "1.2.12", code: 13, url: "https://github.com/DuskBotAI/duskbot-releases/releases/latest/download/DuskBot.apk" } } : {}) });
    return new Response("no", { status: 404 });
  }));
  const host = document.createElement("div");
  host.setAttribute("data-home-list", "");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(PlatformContext, { value: android }, createElement(PhoneUpdateLine, { connection: "place-1" }))); });
  await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
  return { host, root };
}

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; localStorage.clear(); });

describe("update cards on the home list", () => {
  it("the app-too-old card is part of the list, not a layer over the top bar", async () => {
    const { host, root } = await show({ old: true, apk: false });
    const card = host.querySelector<HTMLElement>("[data-phone-update]");
    expect(card?.textContent).toContain("This app is out of date.");
    expect(card!.className).not.toMatch(/\b(fixed|absolute|sticky)\b|\bz-\d/);
    act(() => root.unmount());
  });

  it("the newer-APK card is part of the list too, and closes for that version", async () => {
    const { host, root } = await show({ old: false, apk: true });
    const card = host.querySelector<HTMLElement>("[data-apk-update]");
    expect(card?.textContent).toContain("dusk bot 1.2.12 is out.");
    expect(card!.className).not.toMatch(/\b(fixed|absolute|sticky)\b|\bz-\d/);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Not now"]')!.click());
    expect(host.querySelector("[data-apk-update]")).toBeNull();
    expect(localStorage.getItem("dusk-apk-line:1.2.12")).toBe("1");
    act(() => root.unmount());
  });
});
