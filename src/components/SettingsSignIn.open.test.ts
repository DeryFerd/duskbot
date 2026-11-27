// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const f = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: f.api, useStore: () => ({ refreshInstances: vi.fn(), refreshModels: vi.fn() }) }));
const { ClaudeSignIn } = await import("./ClaudeSignIn");
const { DeviceSignIn } = await import("./DeviceSignIn");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { setLocale("en"); f.api.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe("a Settings sign-in whose page the browser blocked (a plain browser tab)", () => {
  it("Claude says the page did not open until the person opens it", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    f.api.mockResolvedValue({ auth: { phase: "waiting", flowId: "c1", authorizationUrl: "https://claude.com/cai/oauth/authorize?code=true", expiresAt: null } });
    await act(async () => root.render(createElement(ClaudeSignIn, { instanceId: "claude", autoStart: true })));
    await settle();
    expect(window.open).toHaveBeenCalledWith("https://claude.com/cai/oauth/authorize?code=true", "_blank");
    expect(host.textContent).toContain("1. Your browser didn't open the Claude page. Open it and sign in");
    await act(async () => host.querySelector<HTMLAnchorElement>("[data-claude-open]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(host.textContent).toContain("1. Sign in on the Claude page that opened");
  });

  it("ChatGPT says so in its waiting line until the person opens it, and an opened page waits as before", async () => {
    const pkce = { phase: "waiting", flowId: "p1", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?client_id=x", expiresAt: null };
    vi.spyOn(window, "open").mockReturnValueOnce(null);
    f.api.mockResolvedValue({ auth: pkce });
    await act(async () => root.render(createElement(DeviceSignIn, { instanceId: "chatgpt", browserPkce: true, autoStart: true })));
    await settle();
    expect(host.textContent).toContain("Your browser didn't open the sign-in page. Open it with the button above.");
    await act(async () => host.querySelector<HTMLAnchorElement>("[data-device-open]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(host.textContent).toContain("Waiting for you to finish signing in");
    expect(host.textContent).not.toContain("didn't open");
  });
});
