// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { ConnectState } from "./connect-flow";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ dispatch: vi.fn(), refreshModels: vi.fn() }) }));
const { ConnectPanel } = await import("./SignInPill");
const { openSignInPage } = await import("@/lib/app-links");
type Handle = Parameters<typeof ConnectPanel>[0]["flow"];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const handle = (state: ConnectState): Handle & { openAgain: ReturnType<typeof vi.fn> } =>
  ({ state, target: null, start: vi.fn(), cancel: vi.fn(), retry: vi.fn(), openAgain: vi.fn(async () => true), submit: vi.fn() }) as never;
const waiting = (kind: "browser" | "paste", opened: boolean): ConnectState =>
  ({ stage: "waiting", since: Date.now(), kind, flowId: "c1", link: "https://claude.com/cai/oauth/authorize", code: null, opened });
const draw = async (flow: Handle) => act(async () => root.render(createElement(ConnectPanel, { flow, name: "Claude", driverKind: "claudeAgent" })));

describe("a sign-in page the browser did not open", () => {
  it("the browser step says it did not open and leads with Open Claude, which opens it", async () => {
    const flow = handle(waiting("browser", false));
    await draw(flow);
    expect(host.textContent).toContain("Your browser didn't open the Claude page.");
    expect(host.textContent).not.toContain("that opened in your browser");
    const open = host.querySelector<HTMLButtonElement>("[data-connect-open]");
    expect(open?.textContent).toBe("Open Claude");
    await act(async () => open!.click());
    expect(flow.openAgain).toHaveBeenCalledOnce();
  });

  it("the paste step says so too, with Open Claude beside Cancel", async () => {
    await draw(handle(waiting("paste", false)));
    expect(host.textContent).toContain("Your browser didn't open the Claude page. Open it, sign in, then copy the code");
    expect(host.querySelector("[data-connect-open]")?.textContent).toBe("Open Claude");
  });

  it("an opened page keeps the steps as they were", async () => {
    await draw(handle(waiting("browser", true)));
    expect(host.textContent).toContain("Sign in on the Claude page that opened in your browser.");
    expect(host.querySelector("[data-connect-open]")).toBeNull();
    expect(host.textContent).toContain("Open again");
    await draw(handle(waiting("paste", true)));
    expect(host.textContent).toContain("Sign in on the Claude page that opened in your browser, then copy the code");
    expect(host.querySelector("[data-connect-open]")).toBeNull();
  });
});

describe("opening a sign-in page from a browser tab", () => {
  it("knows when the browser blocked it, and never leaves the page a way back to this one", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValueOnce(null);
    await expect(openSignInPage("https://claude.com/x")).resolves.toBe(false);
    const page = { opener: window } as unknown as Window;
    opened.mockReturnValueOnce(page);
    await expect(openSignInPage("https://claude.com/x")).resolves.toBe(true);
    expect(page.opener).toBeNull();
  });
});
