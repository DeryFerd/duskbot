// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { fixtureCatalog } from "../data/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  query: "step=plan",
  trialDays: 0,
  moved: [] as string[],
  finish: vi.fn(async (_home?: string) => {}),
  checkout: vi.fn(async () => true),
}));
vi.mock("../data/cloud", () => ({
  useCloud: () => ({ account: { profile: { name: "Sam", onboarded: false } }, catalog: { ...fixtureCatalog, checkoutOpen: true, ...(state.trialDays ? { trialDays: state.trialDays } : {}) }, billing: null, clouds: [],
    checkout: state.checkout, updateProfile: async () => {}, finishOnboarding: state.finish }),
}));
vi.mock("../data/session", () => ({ useSession: () => ({ account: { id: "a", email: "sam@qa.dusk.test" }, setAccount: () => {}, toast: () => {} }) }));
vi.mock("../lib/router", () => ({ useLocation: () => ({ path: "/welcome", query: new URLSearchParams(state.query) }), navigate: (path: string) => void state.moved.push(path) }));
vi.mock("../lib/analytics", () => ({ track: () => {}, trackOnboardingStep: () => {} }));
vi.mock("../ui/Frame", () => ({ SplitFrame: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
vi.mock("../ui/Mascot", () => ({ Mascot: () => null }));
vi.mock("../ui/Downloads", () => ({ Downloads: () => null }));
vi.mock("../ui/Digits", () => ({ StretchPill: () => null }));

const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; state.moved = []; state.query = "step=plan"; state.trialDays = 0; sessionStorage.clear(); vi.clearAllMocks(); vi.useRealTimers(); });

async function open() {
  const { Onboarding } = await import("./Onboarding");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(Onboarding)));
  return host;
}
const press = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;

test("sent by the app, this computer ends the website's steps on the way back to the app and says so to the account", async () => {
  sessionStorage.setItem("dusk.fromApp", "1");
  const host = await open();
  await act(async () => host.querySelector<HTMLInputElement>("#home-free")!.click());
  await act(async () => press(host, "continue with free").click());
  expect(state.finish).toHaveBeenCalledWith("free");
  expect(state.moved.at(-1)).toBe("/app-signed-in?set=1");
});

test("a plan picked records dusk cloud before the checkout opens, so the app can wait on the payment", async () => {
  sessionStorage.setItem("dusk.fromApp", "1");
  const host = await open();
  await act(async () => press(host, "checkout").click());
  expect(state.finish).toHaveBeenCalledWith("cloud");
  expect(state.checkout).toHaveBeenCalledOnce();
});

test("on the website alone, this computer still goes on to getting the app", async () => {
  const host = await open();
  await act(async () => host.querySelector<HTMLInputElement>("#home-free")!.click());
  await act(async () => press(host, "continue with free").click());
  expect(state.finish).not.toHaveBeenCalled();
  expect(state.moved.at(-1)).toContain("step=app");
});

// the payment page asks for a card and shows the full price with tax: before it opens, the trial says what is charged and when
test("a trial says before checkout that nothing is charged today, then the price and the date it starts", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 27, 12) });
  state.trialDays = 3;
  const host = await open();
  expect(press(host, "start 3-day free trial")).toBeTruthy();
  const terms = host.querySelector("[data-trial-terms]")?.textContent ?? "";
  expect(terms).toContain("nothing is charged today");
  expect(terms).toContain("$20/mo + tax where applicable from 30 nov");
  await act(async () => host.querySelector<HTMLInputElement>("#home-free")!.click());
  expect(host.querySelector("[data-trial-terms]")).toBeNull();
});

test("a plan picked on the site says the same on the way straight to checkout", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 27, 12) });
  state.trialDays = 3;
  state.query = "step=name&plan=plus";
  const host = await open();
  expect(press(host, "start 3-day free trial")).toBeTruthy();
  expect(host.querySelector("[data-trial-terms]")?.textContent).toContain("nothing is charged today. after 3 free days, it's $20/mo + tax where applicable from 30 nov");
});

test("without a trial the plans keep their plain price and no trial line", async () => {
  const host = await open();
  expect(host.querySelector("[data-trial-terms]")).toBeNull();
  expect(press(host, "continue to checkout, $20/mo")).toBeTruthy();
});
