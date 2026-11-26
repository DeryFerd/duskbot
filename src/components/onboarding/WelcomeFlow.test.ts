// @vitest-environment happy-dom
// The first run as a funnel: the hello, then signing in (skipped when already signed in; Continue without an account
// where the install works without one), then one AI choice (the AI already signed in here, free models, or a plan), then
// Dusk's chat; a run on its way to dusk cloud keeps its checkout and the Cloud being made. What each step shows, where it goes, and what it saves.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { introStaged, stageIntro } from "@/lib/default-bot";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, MET_CHIEF_HINT, WELCOME_VERSION } from "@/lib/onboarding";
import type { InstanceInfo } from "@/state/store";
import { stopWaiting } from "@/lib/assistant-notes";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), api: vi.fn(), onDone: vi.fn(),
  improve: [] as unknown[] }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch, refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn() }), api: f.api }));
vi.mock("@/state/api", () => ({ api: f.api }));
// the directory has its own tests; here only that More providers opens it
vi.mock("@/components/models/ModelDirectory", () => ({ ModelDirectory: () => null }));
vi.mock("@/lib/product-analytics", () => ({ setUsageAnalytics: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), setEmailGateDone: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
vi.mock("@/components/mascot-clock", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/components/EngineSetup", async (original) => {
  const { createElement: h } = await import("react");
  return { ...(await original<typeof import("@/components/EngineSetup")>()),
    EngineSetup: ({ instance }: { instance: InstanceInfo }) => h("div", { "data-engine-setup": instance.instanceId }) };
});
vi.mock("@/lib/default-bot", async (original) => ({ ...(await original<typeof import("@/lib/default-bot")>()), useViewerEmail: () => null }));
const { WelcomeFlow } = await import("./WelcomeFlow");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const claude = (ready: boolean, aiTest?: InstanceInfo["aiTest"]): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription", install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] }, ...(aiTest ? { aiTest } : {}),
} as InstanceInfo);
const signedOut = (instanceId: string, driverKind: string, displayName: string, method = "paste-code"): InstanceInfo => ({
  instanceId, driverKind, displayName, access: "subscription", install: { docsUrl: "https://example.test" },
  snapshot: { state: "available", authenticated: false }, authentication: { method }, models: { default: "m", options: [] },
} as InstanceInfo);
const cursor = (ready: boolean): InstanceInfo => ({ ...claude(ready), instanceId: "cursor", driverKind: "cursorAgent", displayName: "Cursor", aiTest: "passed" } as InstanceInfo);
const freeOpenCode = {
  instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode", install: { docsUrl: "https://example.test" },
  snapshot: { state: "available", authenticated: true, freeFallback: true }, models: { default: "opencode/big-pickle", options: [] }, aiTest: "passed",
} as InstanceInfo;
const nothingSignedIn = () => [signedOut("chatgpt", "codex", "ChatGPT plan", "browser-pkce"), signedOut("claude", "claudeAgent", "Claude"),
  signedOut("cursor", "cursorAgent", "Cursor", "device-code"), signedOut("githubCopilot", "copilotAgent", "GitHub Copilot", "device-code")];
const maus = { id: "maus", threadId: "t", name: "Dusk", title: "", description: "", notifications: true, color: "chrome", unread: false,
  modelSelection: { instanceId: "claude", model: "m" }, messages: [], defaultBot: {}, chiefOfStaff: true };

let host: HTMLDivElement, root: Root;
const text = () => document.body.textContent ?? "";
const step = () => document.body.querySelector<HTMLElement>("[data-welcome]")?.dataset.welcome;
const title = () => document.body.querySelector("#welcome-title")?.textContent;
const button = (label: string) => [...document.body.querySelectorAll("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
const press = async (label: string) => {
  const target = button(label);
  if (!target) throw new Error(`no "${label}" button on ${step()}: ${text()}`);
  await act(async () => { target.click(); });
  await settle();
};
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10); }); };
const key = async (name: string) => {
  await act(async () => { document.body.querySelector<HTMLElement>("[data-welcome]")!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
  await settle();
};
const show = async (extra: Record<string, unknown> = {}) => {
  await act(async () => { root.render(createElement(WelcomeFlow, { onDone: f.onDone, ...extra })); });
  await settle();
};
/** Nothing of the person's own here: the AI step's Continue goes on with the free model. */
const goesOn = async () => {
  expect(step()).toBe("ai");
  await press("Continue");
};
const saved = () => f.api.mock.calls.filter(([path, init]) => path === "/api/config" && init?.method === "PUT").map(([, init]) => JSON.parse(init.body));
const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, String(v)), removeItem: (k: string) => void values.delete(k), clear: () => values.clear() };
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.animate = vi.fn(() => ({ onfinish: null, oncancel: null, cancel() {} }) as unknown as Animation);
  setLocale("en");
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  f.dispatch.mockReset();
  f.onDone.mockReset();
  f.api.mockReset();
  f.improve = [];
  stopWaiting();
  f.api.mockImplementation(async (path: string, init?: { body?: string; method?: string }) => {
    if (path.endsWith("/check")) return { ok: true };
    if (path === "/api/dashboard/usage-signals") { if (init?.body) f.improve.push(JSON.parse(init.body)); return init?.body ? JSON.parse(init.body) : { enabled: true }; }
    if (path === "/api/mobile/devices") return { devices: [] };
    if (path === "/api/setup-import/bots") return { apps: [] };
    if (path === "/api/setup-import/grok") return { files: [], bots: [] };
    return path === "/api/instances" ? { instances: f.state.instances } : JSON.parse(init?.body ?? "{}");
  });
  // a fresh computer: nothing of the person's own signed in, the free model ready
  f.state = { hydrated: true, instances: [freeOpenCode, ...nothingSignedIn()], config: { onboarding: EMPTY_ONBOARDING, profile: { name: "" } }, bots: [maus], cloudAdd: null };
  stageIntro(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the welcome", () => {
  it("opens on the welcome with nothing else to decide, and asks nothing about sharing off the desktop app", async () => {
    await show();
    expect(step()).toBe("welcome");
    expect(title()).toBe("Meet dusk bot");
    await press("Get started");
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[data-help-improve]"), "Settings has the switch; the run here has no place step").toBeNull();
    expect(f.onDone).not.toHaveBeenCalled();
    expect(document.body.querySelector("textarea"), "nothing asks for a job").toBeNull();
  });

  it("with Claude already signed in here, goes from Get started straight to Dusk's chat on Claude, connected in the background", async () => {
    f.state = { ...f.state, instances: [freeOpenCode, { ...claude(true, "passed"), found: true }], bots: [{ ...maus, modelSelection: { instanceId: "opencodeGo", model: "opencode/big-pickle" } }] };
    await show();
    await press("Get started");
    expect(step(), "no AI step: the chat opens from here").not.toBe("ai");
    const chose = f.api.mock.calls.filter(([path, init]) => path === "/api/instances/claude" && init?.method === "PATCH");
    expect(chose.map(([, init]) => JSON.parse(init.body)), "marked as theirs with no tap").toEqual([{ chosen: true }]);
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith("maus");
    expect(introStaged("maus")).toBe(true);
    expect(f.dispatch, "Dusk's first chat runs on Claude, not the free model").toHaveBeenCalledWith({ type: "updateBot", botId: "maus", patch: { modelSelection: { instanceId: "claude", model: "m" } } });
    await act(async () => {});
    expect(saved()).toEqual([{ onboarding: expect.objectContaining({ version: WELCOME_VERSION, hintsSeen: [MET_CHIEF_HINT] }) }]);
  });

  it("a found AI whose test went unanswered isn't skipped to: the AI step shows why", async () => {
    f.state = { ...f.state, instances: [freeOpenCode, { ...claude(true, "failed"), found: true }] };
    await show();
    await press("Get started");
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[role=alert]")?.textContent).toContain("Claude");
  });
});

describe("connecting an AI", () => {
  it("shows every AI as a button with its name, and opens the picked one's own sign-in under the grid", async () => {
    f.state = { ...f.state, instances: nothingSignedIn() };
    await show();
    await press("Get started");
    expect(step()).toBe("ai");
    expect(title()).toBe("Connect your AI");
    expect([...document.body.querySelectorAll<HTMLElement>("[data-funnel-ai]")].map((tile) => tile.dataset.funnelAi), "all eight, whatever the server lists")
      .toEqual(["chatgpt", "claude", "grok", "antigravity", "cursor", "copilot", "openrouter", "local"]);
    expect(f.api.mock.calls.some(([, init]) => init?.method === "PATCH"), "nothing found here: nothing marked").toBe(false);
    f.api.mockImplementation(async (path: string) => {
      if (path === "/api/instances?fresh=1") return { instances: f.state.instances };
      if (path === "/api/instances/claude/auth/start") return { auth: { phase: "waiting", flowId: "c1", authorizationUrl: "https://claude.ai/oauth/authorize?x=1" } };
      return {};
    });
    await press("Claude");
    expect(document.body.querySelector("[data-funnel-ai-connect=claude]")).not.toBeNull();
    expect(document.body.querySelector("[data-sign-in=paste]"), "the sign-in opened in the browser, the code goes here").not.toBeNull();
    expect(f.api).toHaveBeenCalledWith("/api/instances/claude/auth/start", expect.objectContaining({ method: "POST" }));
    await press("ChatGPT");
    expect(f.api, "picking another cancels the one under way").toHaveBeenCalledWith("/api/instances/claude/auth/cancel", expect.objectContaining({ method: "POST" }));
    expect(document.body.querySelector("[data-funnel-ai-connect=claude]")).toBeNull();
    await press("More providers or use an API key");
    expect(document.body.querySelector("[data-connect-ai]")).not.toBeNull();
    expect(document.body.querySelector("[data-connect-ai] h2")?.textContent, "it opens on every other provider").toBe("More providers or use an API key");
  });

  it("a card the server doesn't list still works: one switched off comes back, anything else opens every other provider", async () => {
    const base = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (path: string, init?: { body?: string; method?: string }) =>
      path === "/api/instances/hidden" ? { instances: [{ instanceId: "grok", driverKind: "grokAgent", displayName: "Grok" }] } : base(path, init));
    await show({ initialBeat: "ai" });
    expect(document.body.querySelector("[data-funnel-ai=grok][data-missing]")).not.toBeNull();
    await press("Grok");
    expect(f.api).toHaveBeenCalledWith("/api/instances/grok", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ hidden: false }) }));
    await press("Antigravity");
    expect(document.body.querySelector("[data-connect-ai]"), "not here at all: every other provider").not.toBeNull();
  });

  it("shows connected AIs first, as connected and not to be pressed again, with Continue ready and more still to add", async () => {
    const focus = vi.fn(async () => true);
    vi.stubGlobal("duskDesktop", { focusWindow: focus });
    f.state = { ...f.state, instances: [cursor(true), { ...claude(true), instanceId: "chatgpt", driverKind: "codex", displayName: "ChatGPT plan" } as InstanceInfo, signedOut("claude", "claudeAgent", "Claude")] };
    await show({ initialBeat: "ai" });
    expect(title()).toBe("Connect your AI");
    expect([...document.body.querySelectorAll<HTMLElement>("[data-funnel-ai]")].map((tile) => tile.dataset.funnelAi), "the connected ones lead")
      .toEqual(["chatgpt", "cursor", "claude", "grok", "antigravity", "copilot", "openrouter", "local"]);
    const connected = [...document.body.querySelectorAll<HTMLElement>("[data-funnel-ai][data-connected]")].map((tile) => tile.dataset.funnelAi);
    expect(connected).toEqual(["chatgpt", "cursor"]);
    expect(document.body.querySelector("[data-funnel-ai=cursor]")?.tagName, "a connected AI is not a button").toBe("DIV");
    expect(button("Continue")?.className).toContain("ui-button-primary");
    expect(button("Continue")?.disabled).toBe(false);
    expect(document.body.querySelector("button[data-funnel-ai=claude]"), "another can still be added").not.toBeNull();
    await press("Continue");
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith("maus");
  });

  it("with nothing connected, Continue goes on with the free model and says so; a found sign-in that didn't answer isn't connected and says why", async () => {
    const { track } = await import("@/lib/analytics");
    f.state = { ...f.state, instances: [freeOpenCode, ...nothingSignedIn()] };
    await show();
    await press("Get started");
    expect(document.body.querySelector("[data-funnel-free-line]")?.textContent).toBe("Your bots use the free model until you connect one.");
    expect(button("Continue")?.disabled).toBe(false);
    await press("Continue");
    expect(f.onDone).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith("onboarding_ai", { action: "free" });
    expect(f.dispatch, "the free model is a stand-in, never pinned").not.toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ modelSelection: expect.anything() }) }));
    await act(async () => root.unmount());
    root = createRoot(host);
    f.onDone.mockReset();
    f.api.mockClear();
    f.state = { ...f.state, instances: [freeOpenCode, { ...claude(true, "failed"), found: true }] };
    await show({ initialBeat: "ai" });
    expect(document.body.querySelector("[role=alert]")?.textContent).toContain("Claude");
    expect(f.api.mock.calls.some(([path, init]) => path === "/api/instances/claude" && init?.method === "PATCH"), "not connected by itself").toBe(false);
  });

  it("waits on free models while they download, and offers Set up later when none is coming", async () => {
    f.state = { ...f.state, instances: nothingSignedIn(), config: { ...(f.state.config as object), freeBackupDownloading: true } };
    await show();
    await press("Get started");
    expect(button("Continue")?.disabled, "nothing to answer yet").toBe(true);
    expect(document.body.querySelector("[data-funnel-free-line]")?.textContent).toContain("getting ready");
    f.state = { ...f.state, instances: [freeOpenCode, ...nothingSignedIn()], config: { ...(f.state.config as object), freeBackupDownloading: undefined } };
    await show();
    expect(button("Continue")?.disabled).toBe(false);

    f.state = { ...f.state, instances: nothingSignedIn() };
    await show();
    expect(button("Continue")?.disabled).toBe(true);
    expect(f.onDone).not.toHaveBeenCalled();
    await press("Set up later");
    expect(f.onDone).toHaveBeenCalledOnce();
  });

  it("an AI still being checked holds nothing up: it's connected and Continue is ready", async () => {
    f.api.mockImplementation(async (path: string) => (path.endsWith("/check") ? new Promise(() => {}) : {}));
    f.state = { ...f.state, instances: [claude(true, "testing")] };
    await show({ initialBeat: "ai" });
    expect(document.body.querySelector("[data-funnel-ai=claude][data-connected]")).not.toBeNull();
    expect(button("Continue")?.disabled).toBe(false);
  });
});

describe("on the desktop app", () => {
  const desktop = (extra: Record<string, unknown> = {}) => vi.stubGlobal("duskDesktop", { remoteClient: { active: false }, requireUserPresence: async () => true, ...extra });

  it("opens a server from the app on its AI, without the hello the person already saw", async () => {
    desktop({ remoteClient: { active: true } });
    await show();
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[data-funnel-progress]"), "one screen has no progress to show").toBeNull();
  });

  it("with nothing of the person's own here, is two screens: the hello, then connecting an AI, then the chat; never where bots live, bringing in, the phone or permissions", async () => {
    vi.stubEnv("VITE_DUSK_PHONE_APP", "1");
    const macPermissions = { status: async () => ({ accessibility: "denied", screen: "denied", notifications: "denied" }) };
    desktop({ platform: "darwin", macPermissions });
    await show();
    expect(step()).toBe("welcome");
    expect(title()).toBe("Meet dusk bot");
    await press("Get started");
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[data-funnel-progress]")?.getAttribute("data-funnel-progress")).toBe("2/2");
    await press("Back");
    expect(step()).toBe("welcome");
    await press("Get started");
    await goesOn();
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith("maus");
    expect(introStaged("maus"), "Dusk speaks first in its chat").toBe(true);
  });

  it("warms the free model up while the hello shows", async () => {
    f.state = { ...f.state, instances: [freeOpenCode, ...nothingSignedIn()] };
    desktop();
    await show();
    expect(step()).toBe("welcome");
    expect(f.api).toHaveBeenCalledWith("/api/instances/opencodeGo/check", expect.objectContaining({ method: "POST" }));
  });

  it("a run saved on a screen it no longer shows resumes on the AI choice", async () => {
    desktop();
    for (const beat of ["place", "bring", "phone", "permissions"]) {
      localStorage.setItem("dusk.onboarding.welcomeDraft", JSON.stringify({ version: WELCOME_VERSION, beat }));
      await show();
      expect(step(), beat).toBe("ai");
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });

  const cloudBridge = (start: Record<string, unknown>) => {
    const listeners = new Set<(next: unknown) => void>();
    const bridge = {
      now: start as unknown,
      state: vi.fn(async () => bridge.now), refresh: vi.fn(async () => bridge.now), cancel: vi.fn(async () => bridge.now),
      openPage: vi.fn(async () => ({ opened: true })),
      onState: (cb: (next: unknown) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      continueInBrowser: vi.fn(async () => ({ outcome: "opened", state: bridge.now })),
      offer: vi.fn(async () => ({ plans: [{ tier: "starter", amount: 1500, trialDays: 7 }, { tier: "pro", amount: 2900, trialDays: 7 }], recommended: "pro" })),
      holdSignIns: vi.fn(async () => ({ outcome: "held" })), connectHome: vi.fn(async () => ({ status: "connected" })),
      tell: async (next: unknown) => { bridge.now = next; await act(async () => { for (const listener of listeners) listener(next); }); await settle(); },
    };
    return bridge;
  };

  it("an account that already has dusk cloud: the AI with the cloud line, then its cloud being made", async () => {
    const bridge = cloudBridge({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "ready", origin: "https://c1.dusk.test" }] });
    f.state = { ...f.state, instances: [freeOpenCode, ...nothingSignedIn()] };
    desktop({ cloudAccount: bridge });
    await show();
    await press("Get started");
    expect(step()).toBe("ai");
    expect(text()).toContain("Your cloud is getting ready.");
    expect(bridge.continueInBrowser, "no checkout").not.toHaveBeenCalled();
    await press("Continue");
    expect(step()).toBe("making");
  });

  const requiredGate = (gate: { now: { required: boolean; blocked: boolean; status: string }; changed: () => void }) => ({
    state: async () => gate.now, options: async () => ({ providers: ["google"], recovery: true }),
    onChange: (cb: () => void) => { gate.changed = cb; return () => {}; },
  });

  it("signing in on a required account step to an account with dusk cloud goes on to the AI", async () => {
    const bridge = cloudBridge({ status: "signed-out" });
    const gate = { now: { required: true, blocked: true, status: "signed-out" }, changed: () => {} };
    desktop({ cloudAccount: bridge, accountGate: requiredGate(gate) });
    await show();
    await press("Get started");
    expect(step()).toBe("account");
    gate.now = { required: true, blocked: false, status: "connected" };
    await act(async () => { gate.changed(); });
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "ready", origin: "https://c1.dusk.test" }] });
    expect(step()).toBe("ai");
    expect(bridge.continueInBrowser, "no checkout").not.toHaveBeenCalled();
  });

  /** signed in from the account step to a new account, which the website now takes through its first steps */
  const viaWebsite = async () => {
    const bridge = cloudBridge({ status: "signed-out" });
    const gate = { now: { required: true, blocked: true, status: "signed-out" }, changed: () => {} };
    desktop({ cloudAccount: bridge, accountGate: requiredGate(gate) });
    await show();
    await press("Get started");
    expect(step()).toBe("account");
    // one client behind both: the gate reads connected once the session read (with websiteSetup) is in
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [], websiteSetup: "open" });
    gate.now = { required: true, blocked: false, status: "connected" };
    await act(async () => { gate.changed(); });
    await settle();
    expect(step(), "waits while the website's first steps are open").toBe("account");
    expect(text()).toContain("Finish setting up in your browser");
    await press("Open the browser again");
    expect(bridge.openPage).toHaveBeenCalledWith("home");
    return bridge;
  };

  it("a new account picking this computer on the website goes on to the AI", async () => {
    const bridge = await viaWebsite();
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [], websiteSetup: "free" });
    expect(step()).toBe("ai");
    expect(bridge.continueInBrowser, "no checkout").not.toHaveBeenCalled();
  });

  it("a new account picking a plan on the website waits on its checkout here, then skips to the AI once paid", async () => {
    const bridge = await viaWebsite();
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [], websiteSetup: "cloud" });
    expect(step()).toBe("checkout");
    expect(bridge.continueInBrowser, "the website already opened the checkout").not.toHaveBeenCalled();
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, websiteSetup: "cloud", clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "setting_up", origin: "https://c1.dusk.test" }] });
    expect(step()).toBe("ai");
  });

  it("a new account that paid on the website before the app looked skips the checkout", async () => {
    const bridge = await viaWebsite();
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, websiteSetup: "cloud", clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "setting_up", origin: "https://c1.dusk.test" }] });
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[data-funnel-back]"), "no way back to the purchase").toBeNull();
  });

  it("a trial whose cloud is being made counts for a run resumed on the checkout", async () => {
    const bridge = cloudBridge({ status: "connected", clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "setting_up" }], entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 }, trial: { state: "active", endsAt: 1, amount: 1500 } });
    desktop({ cloudAccount: bridge });
    localStorage.setItem("dusk.onboarding.welcomeDraft", JSON.stringify({ version: WELCOME_VERSION, beat: "checkout", cloud: true }));
    await show();
    expect(step()).toBe("ai");
    expect(bridge.continueInBrowser).not.toHaveBeenCalled();
  });

  it("a run resumed on dusk cloud's checkout waits there, and this Mac is one press away", async () => {
    const bridge = cloudBridge({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [] });
    desktop({ cloudAccount: bridge });
    localStorage.setItem("dusk.onboarding.welcomeDraft", JSON.stringify({ version: WELCOME_VERSION, beat: "checkout", cloud: true }));
    await show();
    expect(step()).toBe("checkout");
    expect(title()).toBe("Continue in your browser");
    expect(text(), "no dash anywhere").not.toMatch(/\u2014/);
    await press("Use this computer instead");
    expect(step(), "this Mac's AI choice, with no dead end").toBe("ai");
  });

  it("on dusk cloud: paid in the browser, the AI while the Cloud is made, its sign-ins held, and its chat once ready", async () => {
    const own = (status: string, extra: Record<string, unknown> = {}) => ({ status: "connected", clouds: [{ id: "c1", primary: true, runsOn: "cloud", status, origin: status === "ready" ? "https://c1.dusk.test" : null, ...extra }] });
    const bridge = cloudBridge({ status: "connected", clouds: [] });
    f.state = { ...f.state, instances: [freeOpenCode, ...nothingSignedIn()] };
    desktop({ cloudAccount: bridge });
    localStorage.setItem("dusk.onboarding.welcomeDraft", JSON.stringify({ version: WELCOME_VERSION, beat: "checkout", cloud: true }));
    await show();
    expect(step()).toBe("checkout");
    await bridge.tell(own("setting_up", { setup: { step: "storage", progress: 0.4 } }));
    expect(step(), "paid: the app notices by itself and the AI comes next").toBe("ai");
    expect(text()).toContain("Your cloud is getting ready.");
    expect(document.body.querySelector("[data-funnel-back]"), "no way back to a purchase that is done").toBeNull();
    expect(document.body.querySelector("[data-funnel-progress]")?.getAttribute("data-funnel-progress")).toBe("2/3");
    await press("Continue");
    expect(step()).toBe("making");
    expect(title()).toBe("Making your cloud");
    expect(document.body.querySelector("[data-funnel-making]")?.getAttribute("data-funnel-making")).toBe("setting-up");
    expect(document.body.querySelector("[aria-current=step]")?.textContent, "the checklist ticks one step at a time").toBe("Reserving your machine");
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(document.body.querySelector("[aria-current=step]")?.textContent).toBe("Preparing storage");
    expect(bridge.holdSignIns).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem("dusk.onboarding.welcomeDraft")!), "a closed app comes back here").toMatchObject({ beat: "making", cloud: true });
    let up = false;
    vi.stubGlobal("fetch", vi.fn(async () => { if (!up) throw new TypeError("Failed to fetch"); return new Response(null); }));
    await bridge.tell(own("ready"));
    await settle();
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(title(), "ready at the Admin, but its page doesn't answer yet: still the last check, never a second setup screen").toBe("Making your cloud");
    expect(document.body.querySelector("[aria-current=step]")?.textContent).toBe("Checking it's ready");
    expect(bridge.connectHome).not.toHaveBeenCalled();
    up = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await settle();
    expect(bridge.connectHome).toHaveBeenCalledOnce();
    expect(f.onDone).toHaveBeenCalledOnce();
  });

  it("where the install requires an account, asks for it by Google or an emailed code, and goes on once signed in", async () => {
    const gate = {
      required: true, signedIn: false,
      state: vi.fn(async () => ({ required: gate.required, blocked: !gate.signedIn, status: gate.signedIn ? "connected" : "signed-out" })),
      options: vi.fn(async () => ({ providers: ["google"], recovery: true })),
      signInStart: vi.fn(async (email: string) => ({ outcome: "sent", email, expiresAt: Date.now() + 600_000, resendAt: Date.now() + 30_000, signupOpen: true })),
      signInVerify: vi.fn(async () => { gate.signedIn = true; return { outcome: "signed-in" }; }),
      signInCancel: vi.fn(async () => {}), browser: vi.fn(async () => ({})), cancel: vi.fn(async () => ({})), reopen: vi.fn(), onChange: () => () => {},
    };
    vi.stubEnv("VITE_DUSK_PHONE_APP", "0");
    desktop({ accountGate: gate });
    await show();
    expect(step(), "the hello comes first").toBe("welcome");
    await press("Get started");
    expect(step()).toBe("account");
    expect(title()).toBe("Sign in to dusk bot");
    expect(text(), "no phone in the pitch while its app is hidden").toContain("One account for your bots and dusk cloud.");
    expect(document.body.querySelector("[data-sign-in-legal]"), "signing in is where the terms line lives").not.toBeNull();
    expect(text(), "no price claim in the pitch").not.toContain("Free.");
    expect(button("Continue with Google")).toBeDefined();
    expect(button("Continue without an account"), "required here").toBeUndefined();
    await type(document.body.querySelector<HTMLInputElement>("input[type=email]")!, "person@example.com");
    await press("Email me a code");
    expect(gate.signInStart).toHaveBeenCalledWith("person@example.com");
    const digits = [...document.body.querySelectorAll<HTMLInputElement>("input")];
    for (const [index, digit] of digits.entries()) await type(digit, String(index + 1));
    await press("Sign in");
    expect(gate.signInVerify).toHaveBeenCalledWith("12345678");
    expect(step()).toBe("ai");
  });

  /** the packaged app's account bridge, where an account is optional: signed out unless told otherwise */
  const optionalGate = (start: { status: string } = { status: "signed-out" }) => {
    const listeners = new Set<() => void>();
    const gate = {
      now: start,
      state: vi.fn(async () => ({ required: false, blocked: false, ...gate.now })),
      options: vi.fn(async () => ({ providers: ["google", "apple"], recovery: true })),
      signInStart: vi.fn(async (email: string) => ({ outcome: "sent", email, expiresAt: Date.now() + 600_000, resendAt: Date.now() + 30_000, signupOpen: true })),
      signInVerify: vi.fn(async () => { gate.now = { status: "connected" }; return { outcome: "signed-in" }; }),
      signInCancel: vi.fn(async () => {}), browser: vi.fn(async () => ({})), cancel: vi.fn(async () => ({})), reopen: vi.fn(),
      onChange: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      tell: async (next: { status: string }) => { gate.now = next; await act(async () => { for (const listener of listeners) listener(); }); await settle(); },
    };
    return gate;
  };

  it("signing in comes right after Get started and before the AI choice, with a quiet way on without an account", async () => {
    vi.stubEnv("VITE_DUSK_PHONE_APP", "0");
    desktop({ accountGate: optionalGate() });
    await show();
    expect(step(), "the hello comes first").toBe("welcome");
    await press("Get started");
    expect(step()).toBe("account");
    expect(title()).toBe("Sign in to dusk bot");
    expect(document.body.querySelector("[data-funnel-progress]")?.getAttribute("data-funnel-progress")).toBe("2/3");
    expect(button("Continue with Google")).toBeDefined();
    expect(document.body.querySelector("[data-sign-in-legal]"), "signing in is where the terms line lives").not.toBeNull();
    expect(text(), "no dash anywhere").not.toMatch(/\u2014/);
    await press("Continue without an account");
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[data-funnel-progress]")?.getAttribute("data-funnel-progress")).toBe("3/3");
    await press("Back");
    expect(step(), "back goes to the sign-in").toBe("account");
  });

  it("with Claude signed in here: hello, sign in, then straight to Dusk's chat", async () => {
    f.state = { ...f.state, instances: [freeOpenCode, { ...claude(true, "passed"), found: true }] };
    desktop({ accountGate: optionalGate() });
    await show();
    await press("Get started");
    expect(step()).toBe("account");
    expect(document.body.querySelector("[data-funnel-progress]")?.getAttribute("data-funnel-progress"), "two screens").toBe("2/2");
    await press("Continue without an account");
    expect(step()).not.toBe("ai");
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith("maus");
  });

  it("signing in with an emailed code goes on to the AI choice by itself", async () => {
    const gate = optionalGate();
    desktop({ accountGate: gate });
    await show();
    await press("Get started");
    expect(step()).toBe("account");
    await type(document.body.querySelector<HTMLInputElement>("input[type=email]")!, "person@example.com");
    await press("Email me a code");
    const digits = [...document.body.querySelectorAll<HTMLInputElement>("input")];
    for (const [index, digit] of digits.entries()) await type(digit, String(index + 1));
    await press("Sign in");
    expect(gate.signInVerify).toHaveBeenCalledWith("12345678");
    expect(step()).toBe("ai");
  });

  it("Back from the AI choice after signing in stays on the sign-in, which says who is signed in", async () => {
    const gate = optionalGate();
    desktop({ accountGate: gate });
    await show();
    await press("Get started");
    await type(document.body.querySelector<HTMLInputElement>("input[type=email]")!, "person@example.com");
    await press("Email me a code");
    const digits = [...document.body.querySelectorAll<HTMLInputElement>("input")];
    for (const [index, digit] of digits.entries()) await type(digit, String(index + 1));
    await press("Sign in");
    // main tells every window of the new sign-in too, a moment after the code is taken
    await gate.tell({ status: "connected" });
    expect(step()).toBe("ai");
    await press("Back");
    expect(step()).toBe("account");
  });

  it("someone already signed in (handed over from the website, or from before) goes from the hello straight to the AI choice", async () => {
    desktop({ accountGate: optionalGate({ status: "connected" }) });
    await show();
    await press("Get started");
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[data-funnel-progress]")?.getAttribute("data-funnel-progress")).toBe("2/2");
  });

  it("a sign-in that lands while the hello shows skips the sign-in step", async () => {
    const gate = optionalGate();
    desktop({ accountGate: gate });
    await show();
    expect(step()).toBe("welcome");
    await gate.tell({ status: "connected" });
    await press("Get started");
    expect(step()).toBe("ai");
  });

  it("a run saved on the sign-in resumes there, or on the AI choice once signed in", async () => {
    localStorage.setItem("dusk.onboarding.welcomeDraft", JSON.stringify({ version: WELCOME_VERSION, beat: "account" }));
    desktop({ accountGate: optionalGate() });
    await show();
    expect(step()).toBe("account");
    await act(async () => root.unmount());
    root = createRoot(host);
    localStorage.setItem("dusk.onboarding.welcomeDraft", JSON.stringify({ version: WELCOME_VERSION, beat: "account" }));
    desktop({ accountGate: optionalGate({ status: "connected" }) });
    await show();
    expect(step()).toBe("ai");
  });

  it("a replay from Settings never asks to sign in", async () => {
    desktop({ accountGate: optionalGate() });
    await show({ replay: true });
    await press("Get started");
    expect(step()).toBe("ai");
  });

  it("never offers to go on without an account where the app needs one", async () => {
    desktop({ accountGate: { state: async () => ({ required: true, blocked: true, status: "signed-out" }), options: async () => ({ providers: [], recovery: false }), onChange: () => () => {} } });
    await show();
    await press("Get started");
    expect(step()).toBe("account");
    expect(button("Continue without an account")).toBeUndefined();
    await key("Escape");
    expect(step()).toBe("account");
  });

});

describe("Dusk as the Chief", () => {
  it("makes Dusk the Chief only where there is none", async () => {
    f.state = { ...f.state, bots: [{ ...maus, chiefOfStaff: false }] };
    await show();
    await press("Get started");
    await goesOn();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "maus", patch: { welcomed: true, chiefOfStaff: true } });
  });

  it("lands on no bot where another bot is already the Chief", async () => {
    f.state = { ...f.state, bots: [{ ...maus, chiefOfStaff: false }, { ...maus, id: "research", threadId: "r", name: "Research", defaultBot: undefined, chiefOfStaff: true }] };
    await show();
    await press("Get started");
    await goesOn();
    expect(f.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateBot" }));
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith(null);
  });
});

describe("other first runs", () => {
  it("a replay from Settings records nothing about a first chat", async () => {
    f.state = { ...f.state, config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01T00:00:00.000Z", version: WELCOME_VERSION } } };
    await show({ replay: true });
    await press("Get started");
    await goesOn();
    await act(async () => {});
    expect(f.onDone).toHaveBeenCalledOnce();
    expect(saved()[0].onboarding).not.toHaveProperty("hintsSeen");
    expect(introStaged("maus"), "a replay lands in a chat that may be long under way").toBe(false);
  });
});

describe("the funnel's back button", () => {
  it("starts clear of macOS's traffic lights, and in the corner elsewhere", async () => {
    const { FunnelBar } = await import("./FunnelSteps");
    const { DesktopCapabilitiesProvider } = await import("../DesktopCapabilities");
    const { cacheDesktopCapabilities, initialDesktopCapabilities } = await import("@/lib/desktop");
    const backAt = async (platform: string | null) => {
      vi.stubGlobal("duskDesktop", platform ? { platform, getCapabilities: async () => initialDesktopCapabilities() } : undefined);
      cacheDesktopCapabilities(initialDesktopCapabilities());
      await act(async () => { root.render(createElement(DesktopCapabilitiesProvider, null, createElement(FunnelBar, { at: 1, count: 3, onBack: () => {} }))); });
      await settle();
      return document.body.querySelector<HTMLElement>("[data-funnel-back]")!.getAttribute("data-funnel-back");
    };
    expect(await backAt("darwin")).toBe("clear-of-traffic-lights");
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(await backAt("win32"), "Windows keeps its caption buttons on the right").toBe("");
  });
});
