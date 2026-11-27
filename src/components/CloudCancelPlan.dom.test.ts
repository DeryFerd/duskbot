// @vitest-environment happy-dom
import { createElement, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState, CloudPlanBridge, CloudRenewalResult, CloudRetentionStep } from "../../electron/cloud-account.mjs";
import type { CloudUsage } from "../../electron/cloud-home.mjs";
import type { CloudRenewal } from "../../electron/cloud-list.mjs";
import { setLocale } from "@/lib/i18n";
import type { AccountRecap } from "../../shared/account-recap";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" } }, ready: true }) }));
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: { bots: [], config: {} }, dispatch: vi.fn() }) }));
import { CANCEL_HELP_URL, CloudCancelPlan, type CloudCancelOffers, type CloudRenewalActions } from "./CloudCancelPlan";
import { CloudAccountSettings, CloudPlanOnCloud } from "./CloudAccountSettings";
import { PlanBillingPage } from "./PlanBilling";

const NOW = Date.UTC(2026, 9, 28, 12), DAY = 86_400_000, END = NOW + 5 * DAY;
const day = (value: number) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
const paid: CloudRenewal = { trial: false, cancelled: false, renewsAt: END, endsAt: null, keptDays: 30 };
const cancelledPaid: CloudRenewal = { ...paid, cancelled: true, renewsAt: null, endsAt: END };
const trial: CloudRenewal = { trial: true, cancelled: false, renewsAt: END, endsAt: null, keptDays: 3 };
const usage: CloudUsage = { tier: "pro", resetsAt: END, upgrades: [], meters: [
  { kind: "computerHours", used: 14.5, max: 60 }, { kind: "decisions", used: 0, max: 2000 }, { kind: "storage", used: 6, max: 60 }] };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const show = async (element: ReactElement) => { await act(async () => { root.render(element); }); await settle(); };
const sheet = () => document.querySelector<HTMLElement>("[role='dialog']");
const step = () => sheet()?.getAttribute("data-cloud-cancel-sheet");
const title = () => sheet()?.querySelector("h2")?.textContent;
const text = () => document.body.textContent ?? "";
const button = (label: string, within: ParentNode = document.body) => [...within.querySelectorAll("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label);
const click = async (target: Element | null | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); await settle(); };
const radio = (label: string) => [...sheet()!.querySelectorAll("label")].find(item => item.textContent === label)?.querySelector("input");
const write = async (value: string) => {
  const box = sheet()!.querySelector("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value); box.dispatchEvent(new Event("input", { bubbles: true })); });
};
const next = () => click(sheet()!.querySelector("[data-cloud-cancel-next]"));
const open = () => click(button("Cancel subscription"));
const choose = async (label: string) => { await click(radio(label)); await next(); };
/** the sheet's own buttons at its foot, left to right */
const foot = () => [...sheet()!.querySelectorAll("button")].filter(item => item.getAttribute("aria-label") !== "Close").slice(-2).map(item => item.textContent);
const dots = () => sheet()?.querySelector("[data-cloud-cancel-dots]")?.getAttribute("data-cloud-cancel-dots");
/** past the recap to Why are you leaving? */
const toWhy = async () => { expect(step()).toBe("recap"); await next(); expect(step()).toBe("why"); };
const crew = [{ id: "nova", name: "Nova", color: "blue", body: "blob", replies: 1120 }, { id: "quill", name: "Quill", color: "purple", body: "clover", replies: 684 }, { id: "rivet", name: "Rivet", color: "orange", body: "hex", replies: 402 }];
const RECAP: AccountRecap = { v: 1, since: Date.UTC(2026, 2, 4), bots: 3, crew, topBot: crew[0]!, replies: 2206, activeDays: 140, longestStreak: 23, routines: 6, apps: 1, computers: 2 };
/** What main answers: a cancel that turns renewal off (when it ends from the Admin), a keep, or as told; every step logged. */
function actionsFor(results: Partial<{ cancel: CloudRenewalResult; keep: CloudRenewalResult }> = {}) {
  const state = { status: "connected" } as CloudAccountState;
  return {
    cancel: vi.fn(async () => results.cancel ?? { outcome: "cancelled" as const, renewal: cancelledPaid, surveyed: true, state }),
    keep: vi.fn(async () => results.keep ?? { outcome: "kept" as const, state }),
    retention: vi.fn(async (step: CloudRetentionStep) => Boolean(step)),
  } satisfies CloudRenewalActions;
}

describe("the cancel sheet", () => {
  it("a look back, why, one offer, what you'd lose, confirm, done: every screen goes on with Continue to cancel, each step is logged, and Resume puts it back", async () => {
    const actions = actionsFor(), changed = vi.fn(), openPlans = vi.fn(async () => undefined), recap = vi.fn(async () => RECAP);
    await show(createElement(CloudCancelPlan, { renewal: paid, actions, offers: { cheaper: "Plus", openPlans, recap }, onChanged: changed }));
    const link = button("Cancel subscription")!;
    expect(link.className).toContain("underline");
    await open();
    expect(sheet()!.getAttribute("aria-modal")).toBe("true");
    expect([step(), title(), dots()]).toEqual(["recap", "Look what you and your bots did", "1/5"]);
    expect(recap).toHaveBeenCalledOnce();
    expect(text()).toContain("You've been at it together since March 2026.");
    expect(Object.fromEntries([...sheet()!.querySelectorAll("[data-cloud-cancel-stat]")].map(item => [item.getAttribute("data-cloud-cancel-stat"), item.textContent]))).toEqual({
      replies: "Replies from your bots2,206", days: "Days you worked together140", streak: "Days in a row, your best streak23", routines: "Routines on a schedule6", apps: "App connected1", bots: "Bots you made3" });
    expect(sheet()!.querySelector("[data-cloud-cancel-top]")?.textContent).toBe("Nova did the most: 1,120 replies.");
    expect(sheet()!.querySelector("[data-cancel-scene='day']")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Keep my plan");
    expect(sheet()!.querySelector("[data-cloud-cancel-next]")?.textContent).toBe("Continue to cancel");
    expect(foot()).toEqual(["Continue to cancel", "Keep my plan"]);
    await next();
    expect([step(), title(), dots()]).toEqual(["why", "Why are you leaving?", "2/5"]);
    expect(actions.retention).not.toHaveBeenCalled();
    expect([...sheet()!.querySelectorAll("input[type=radio]")].map(input => input.closest("label")!.textContent))
      .toEqual(["Too expensive", "Not using it enough", "Missing a feature", "Switching to something else", "Technical problems", "Prefer not to say"]);
    expect(sheet()!.querySelector("label:has(textarea)")?.textContent).toBe("Anything else you'd like us to know? (Optional)");
    // Continue with nothing picked says so and stays
    await next();
    expect(step()).toBe("why");
    expect(sheet()!.querySelector("[role='alert']")?.textContent).toBe("Pick one, or choose Prefer not to say.");
    expect(actions.retention).not.toHaveBeenCalled();
    await click(radio("Too expensive"));
    expect(sheet()!.querySelector("[role='alert']")).toBeNull();
    await write("  Too much for a side project.  ");
    await next();
    expect(actions.retention).toHaveBeenLastCalledWith({ reason: "price", step: "reason", outcome: "shown", note: "Too much for a side project." });
    expect([step(), title(), dots()]).toEqual(["offer", "Try a smaller plan", "3/5"]);
    expect(text()).toContain("Plus costs less and keeps your bots running on dusk cloud.");
    expect(foot()).toEqual(["Continue to cancel", "See plans"]);
    await next();
    expect(actions.retention).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "shown", offer: "downgrade", note: "Too much for a side project." });
    expect([step(), title(), dots()]).toEqual(["losses", "What you'd lose", "4/5"]);
    expect(sheet()!.querySelector("[data-cancel-scene='dusk']")).toBeTruthy();
    expect(text()).toContain(`Everything keeps working until ${day(END)}. After that:`);
    expect([...sheet()!.querySelectorAll("li")].map(item => item.textContent)).toEqual(["Nova, Quill, and Rivet stop working when your Mac sleeps.", "Your 6 routines only run while your Mac is awake.",
      "The app they use only works while your Mac is awake.", `Your dusk cloud files, and what your bots remember there, are kept until ${day(END + 30 * DAY)}, then deleted.`]);
    await next();
    expect([step(), title(), dots()]).toEqual(["confirm", "Cancel your plan", "5/5"]);
    expect(text()).toContain(`Your plan ends on ${day(END)}, not today.`);
    expect(foot()).toEqual(["Cancel subscription", "Keep my plan"]);
    expect(document.activeElement?.textContent).toBe("Keep my plan");
    expect(sheet()!.querySelector("[data-cloud-cancel-next]")).toBeNull();
    await click(sheet()!.querySelector("[data-cloud-cancel-confirm]"));
    expect(actions.cancel).toHaveBeenCalledExactlyOnceWith({ answer: "price", offer: "downgrade", improve: "Too much for a side project." });
    expect(actions.retention).toHaveBeenCalledTimes(2);
    expect([step(), title(), dots()]).toEqual(["done", "Your subscription is cancelled", undefined]);
    expect(sheet()!.querySelector("[data-cancel-scene='night']")).toBeTruthy();
    expect(sheet()!.querySelector("[role='status']")?.textContent).toBe(`You have access until ${day(END)}.`);
    expect(text()).toContain("Resume anytime before then, and nothing changes.");
    expect(changed).not.toHaveBeenCalled();
    await click(button("Resume subscription", sheet()!));
    expect(actions.keep).toHaveBeenCalledOnce();
    expect([sheet(), changed.mock.calls.length, openPlans.mock.calls.length]).toEqual([null, 1, 0]);
  });

  it("the look back reads plainly with no recap, and Continue to cancel never waits on it", async () => {
    const actions = actionsFor();
    await show(createElement(CloudCancelPlan, { renewal: paid, actions }));
    await open();
    expect(text()).toContain("Before you go, here's what you and your bots did together.");
    expect(text()).toContain("Your bots are set up and ready whenever you are.");
    await act(async () => root.unmount()); root = createRoot(container);
    const never = vi.fn(() => new Promise<AccountRecap | null>(() => {}));
    await show(createElement(CloudCancelPlan, { renewal: paid, actions, offers: { recap: never } }));
    await open();
    expect(sheet()!.querySelector("[aria-busy='true']")).toBeTruthy();
    await next();
    expect(step()).toBe("why");
  });

  it("Prefer not to say counts and goes straight to what you'd lose, its one offer; Continue to cancel always goes on to the cancel", async () => {
    const actions = actionsFor();
    await show(createElement(CloudCancelPlan, { renewal: paid, actions }));
    await open();
    await toWhy();
    await choose("Prefer not to say");
    expect([step(), title(), dots()]).toEqual(["losses", "What you'd lose", "3/4"]);
    expect([...sheet()!.querySelectorAll("li")].map(item => item.textContent)).toEqual(["Bots on dusk cloud stop running when your Mac is asleep or off.", "Routines on dusk cloud stop.",
      `Your dusk cloud files, and what your bots remember there, are kept until ${day(END + 30 * DAY)}, then deleted.`]);
    await next();
    expect([step(), dots()]).toEqual(["confirm", "4/4"]);
    await click(sheet()!.querySelector("[data-cloud-cancel-confirm]"));
    expect(actions.cancel).toHaveBeenCalledExactlyOnceWith({ answer: "skip", offer: "losses" });
    expect(actions.retention.mock.calls.map(([call]) => call)).toEqual([{ reason: "skip", step: "reason", outcome: "shown" }, { reason: "skip", step: "help", outcome: "shown", offer: "losses" }]);
  });

  it("one offer for each reason, only what the app can do; taking it keeps the plan and logs it, and never cancels", async () => {
    const openLink = vi.fn(async (url: string) => void url), openPlans = vi.fn(async () => undefined);
    const cases: Array<{ answer: string; renewal?: CloudRenewal; offers?: CloudCancelOffers; title: string; offer: string; take: string; outcome: string; says?: string; lines?: string[] }> = [
      { answer: "Too expensive", offers: { cheaper: "Plus", openPlans }, title: "Try a smaller plan", offer: "downgrade", take: "See plans", outcome: "helped" },
      // a trial or no cheaper plan: personal use on the Mac stays free
      { answer: "Too expensive", renewal: trial, offers: { cheaper: "Plus", openPlans }, title: "Your Mac stays free", offer: "help", take: "Keep my plan", outcome: "kept", says: "Personal use on your Mac stays free. Only dusk cloud is paid." },
      { answer: "Not using it enough", offers: { usage }, title: "This month on dusk cloud", offer: "help", take: "Keep my plan", outcome: "kept", lines: ["Cloud desktop hours: 14.5 of 60 hours"] },
      { answer: "Not using it enough", title: "Get more out of it", offer: "help", take: "Keep my plan", outcome: "kept", says: "Bots on dusk cloud can run routines while you're away, like a morning brief." },
      { answer: "Missing a feature", offers: { openLink }, title: "Tell us what's missing", offer: "note", take: "Email us", outcome: "helped" },
      { answer: "Technical problems", offers: { openLink }, title: "Let's fix it", offer: "help", take: "Open help", outcome: "helped" },
    ];
    for (const one of cases) {
      const actions = actionsFor();
      await show(createElement(CloudCancelPlan, { key: `${one.answer}${one.title}`, renewal: one.renewal ?? paid, actions, offers: one.offers ?? {} }));
      await open();
      await toWhy();
      await choose(one.answer);
      expect([title(), sheet()!.getAttribute("data-cloud-cancel-offer")], one.title).toEqual([one.title, one.offer]);
      if (one.says) expect(text()).toContain(one.says);
      if (one.lines) expect([...sheet()!.querySelectorAll("li")].map(item => item.textContent)).toEqual(one.lines);
      expect(button("Continue to cancel")).toBeTruthy();
      await click(button(one.take, sheet()!));
      expect(sheet(), one.title).toBeNull();
      expect(actions.retention).toHaveBeenLastCalledWith(expect.objectContaining({ step: "help", outcome: one.outcome, offer: one.offer }));
      expect(actions.cancel).not.toHaveBeenCalled();
      await act(async () => root.unmount()); root = createRoot(container);
    }
    expect(openPlans).toHaveBeenCalledOnce();
    expect(openLink.mock.calls.map(([url]) => url)).toEqual([expect.stringMatching(/^mailto:hello@dusk\.bot\?subject=Missing%20from%20dusk%20cloud$/), CANCEL_HELP_URL]);
  });

  it("every reason reaches the cancel with Continue to cancel alone, through at most one offer", async () => {
    for (const [answer, screens] of [["Too expensive", ["offer", "losses"]], ["Not using it enough", ["offer", "losses"]], ["Missing a feature", ["offer", "losses"]],
      ["Switching to something else", ["losses"]], ["Technical problems", ["offer", "losses"]], ["Prefer not to say", ["losses"]]] as const) {
      const actions = actionsFor();
      await show(createElement(CloudCancelPlan, { key: answer, renewal: paid, actions }));
      await open();
      await toWhy();
      await choose(answer);
      for (const screen of screens) { expect(step(), answer).toBe(screen); await next(); }
      expect(step(), answer).toBe("confirm");
      await click(sheet()!.querySelector("[data-cloud-cancel-confirm]"));
      expect(actions.cancel, answer).toHaveBeenCalledOnce();
      await act(async () => root.unmount()); root = createRoot(container);
    }
  });

  it("Keep my plan on every screen closes the sheet and logs kept once a reason is picked; a failed cancel says so and stays; an Admin without Cancel says billing opened", async () => {
    const actions = actionsFor();
    await show(createElement(CloudCancelPlan, { renewal: paid, actions }));
    await open();
    await click(button("Keep my plan", sheet()!));
    expect([sheet(), actions.retention.mock.calls.length]).toEqual([null, 0]);
    const kept: Array<[string, string]> = [];
    for (const [at, logged] of [["why", "reason"], ["offer", "help"], ["losses", "confirm"], ["confirm", "confirm"]] as const) {
      await open();
      await toWhy();
      if (at !== "why") { await choose("Not using it enough"); while (step() !== at) await next(); } else await click(radio("Not using it enough"));
      await click(button("Keep my plan", sheet()!));
      expect(sheet(), at).toBeNull();
      kept.push([at, actions.retention.mock.calls.at(-1)![0].step]);
      expect(actions.retention).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "unused", step: logged, outcome: "kept" }));
    }
    expect(kept.length).toBe(4);
    expect([actions.cancel.mock.calls.length, actions.keep.mock.calls.length]).toEqual([0, 0]);
    await open();
    await toWhy();
    await choose("Switching to something else");
    await click(button("Keep my plan", sheet()!));
    expect(actions.retention).toHaveBeenLastCalledWith({ reason: "switching", step: "help", outcome: "kept", offer: "losses" });

    const failing = actionsFor({ cancel: { outcome: "failed", state: { status: "connected" } } });
    failing.retention.mockRejectedValue(new Error("offline"));
    await show(createElement(CloudCancelPlan, { renewal: paid, actions: failing }));
    await open();
    await toWhy();
    await choose("Switching to something else");
    await next();
    await click(sheet()!.querySelector("[data-cloud-cancel-confirm]"));
    expect(sheet()!.querySelector("[role='alert']")?.textContent).toBe("That didn't go through, and nothing changed. Try again in a minute.");
    expect(step()).toBe("confirm");
    failing.cancel.mockResolvedValueOnce({ outcome: "browser" });
    await click(sheet()!.querySelector("[data-cloud-cancel-confirm]"));
    expect(sheet()!.querySelector("[role='status']")?.textContent).toBe("The cloud page's billing opened in your browser. You can do it there.");
    await click(button("Done"));
    expect(sheet()).toBeNull();
  });

  it("names a few bots and counts the rest in the app's language", async () => {
    const { botNames } = await import("./CloudCancelPlan");
    expect(botNames(["Nova", "Quill", "Rivet", "Juno", "Basil"], 6)).toBe("Nova, Quill, Rivet, and 3 more");
    expect(botNames(["Nova", "Quill"], 2)).toBe("Nova and Quill");
    expect(botNames([], 0)).toBeNull();
  });

  it("already cancelled: when it ends and Resume subscription, never Cancel; nothing at all without a renewal or a way to change it", async () => {
    const actions = actionsFor(), changed = vi.fn();
    await show(createElement(CloudCancelPlan, { renewal: cancelledPaid, actions, onChanged: changed }));
    expect(container.querySelector("[data-cloud-cancel]")?.getAttribute("data-cloud-cancel")).toBe("cancelled");
    expect(container.querySelector("[role='status']")?.textContent).toBe(`Cancelled. Your plan ends on ${day(END)}. You won't be charged again.`);
    expect(button("Cancel subscription")).toBeUndefined();
    await click(button("Resume subscription"));
    expect([actions.keep.mock.calls.length, changed.mock.calls.length]).toEqual([1, 1]);
    actions.keep.mockResolvedValueOnce({ outcome: "browser" });
    await click(button("Resume subscription"));
    expect(container.textContent).toContain("The cloud page's billing opened in your browser.");
    await show(createElement(CloudCancelPlan, { renewal: undefined, actions }));
    expect(container.innerHTML).toBe("");
    await show(createElement(CloudCancelPlan, { renewal: paid, actions: null }));
    expect(container.innerHTML).toBe("");
  });

  it("keeps its sheet open while main's state changes underneath (the plan cancelled), and Escape closes it", async () => {
    const actions = actionsFor();
    await show(createElement(CloudCancelPlan, { renewal: paid, actions }));
    await open();
    await toWhy();
    await choose("Prefer not to say");
    await next();
    await click(sheet()!.querySelector("[data-cloud-cancel-confirm]"));
    await show(createElement(CloudCancelPlan, { renewal: cancelledPaid, actions }));
    expect(step()).toBe("done");
    await act(async () => { sheet()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();
    expect(sheet()).toBeNull();
  });
});

describe("the plan's place", () => {
  const paidState = (renewal?: CloudRenewal): CloudAccountState => ({ status: "connected", account: { id: "a", email: "person@example.test" },
    entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, verifiedAt: NOW, verifiedUntil: NOW + DAY, ...(renewal ? { renewal } : {}) });
  function accountBridge(state: CloudAccountState) {
    return { state: vi.fn(async () => state), begin: vi.fn(), signInAgain: vi.fn(), reopen: vi.fn(), cancel: vi.fn(), refresh: vi.fn(async () => state), signOut: vi.fn(),
      openDashboard: vi.fn(async () => state), connectHome: vi.fn(), connectHomeForPhone: vi.fn(), onState: vi.fn(() => () => {}),
      openPage: vi.fn(async () => ({ opened: true })), continueInBrowser: vi.fn(async () => ({ outcome: "opened" as const, state })), retention: vi.fn(async () => true), recap: vi.fn(async () => RECAP),
      cancelPlan: vi.fn(async () => ({ outcome: "cancelled" as const, renewal: cancelledPaid, surveyed: true, state })), keepPlan: vi.fn(async () => ({ outcome: "kept" as const, state })) };
  }

  it("this computer's Settings: a failed charge says the cloud is stopped and until when its data is kept, and Update card opens billing", async () => {
    const bridge = accountBridge({ ...paidState(), payment: { name: "Night shift", fixBy: Date.UTC(2026, 11, 21, 12) } });
    vi.stubGlobal("window", Object.assign(window, { duskDesktop: { cloudAccount: bridge as unknown as CloudAccountBridge } }));
    await show(createElement(CloudAccountSettings));
    expect(container.querySelector("[data-cloud-payment]")!.textContent).toMatch(/^Your payment didn't go through\. Update your card to get Night shift back\. Its data is kept until Dec 21, 2026\.Update card$/);
    await click(button("Update card"));
    expect(bridge.continueInBrowser).toHaveBeenCalledExactlyOnceWith({ kind: "billing" });
  });

  it("the dusk cloud card no longer manages or cancels a running plan; a trial set to end still says Subscribe", async () => {
    vi.stubGlobal("window", Object.assign(window, { duskDesktop: { cloudAccount: accountBridge(paidState(paid)) as unknown as CloudAccountBridge } }));
    await show(createElement(CloudAccountSettings));
    expect(text()).toContain("Pro active · verified by dusk cloud");
    for (const gone of ["Manage cloud subscription", "Cancel subscription", "Cancel plan", "Open your plan page"]) expect(button(gone), gone).toBeUndefined();
    await act(async () => root.unmount()); root = createRoot(container);
    const ending = { ...paidState({ ...trial, cancelled: false }), trial: { state: "ending" as const, tier: "pro", endsAt: END, amount: 4900, chargeAt: null, holdUntil: null, deleteAt: END + 3 * DAY, keep: "portal" as const } };
    vi.stubGlobal("window", Object.assign(window, { duskDesktop: { cloudAccount: accountBridge(ending) as unknown as CloudAccountBridge } }));
    await show(createElement(CloudAccountSettings));
    expect(button("Subscribe to keep it")).toBeTruthy();
  });

  it("the Cloud page: Manage in your browser only while no plan runs, and no cancel there", async () => {
    let snapshot: Awaited<ReturnType<CloudPlanBridge["state"]>> = { status: "paid", tier: "pro", home: true, renewal: paid };
    const plan: CloudPlanBridge = { state: vi.fn(async () => snapshot), manage: vi.fn(async () => undefined), cancel: vi.fn(), keep: vi.fn() };
    await show(createElement(CloudPlanOnCloud, { bridge: plan }));
    expect([button("Manage in your browser"), button("Cancel subscription")]).toEqual([undefined, undefined]);
    snapshot = { status: "attention", tier: "pro", home: true };
    await act(async () => root.unmount()); root = createRoot(container);
    await show(createElement(CloudPlanOnCloud, { bridge: plan }));
    expect(button("Manage in your browser")).toBeTruthy();
  });

  it("Plan & billing: the plan and when it renews, the card and invoices on the account page, and Cancel subscription last, through main", async () => {
    const bridge = accountBridge({ ...paidState(paid), usage });
    vi.stubGlobal("window", Object.assign(window, { duskDesktop: { cloudAccount: bridge as unknown as CloudAccountBridge } }));
    await show(createElement(PlanBillingPage));
    expect(text()).toContain("Pro active · verified by dusk cloud");
    expect(text()).toContain(`Renews on ${day(END)}`);
    await click(button("Payment method and invoicesOn your account page in the browser") ?? [...container.querySelectorAll("button")].find(item => item.textContent?.startsWith("Payment method and invoices")));
    expect(bridge.openPage).toHaveBeenCalledExactlyOnceWith("billing");
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.at(-1)?.textContent).toBe("Cancel subscription");
    await open();
    expect(bridge.recap).toHaveBeenCalledOnce();
    expect(text()).toContain("Nova did the most: 1,120 replies.");
    await toWhy();
    await choose("Too expensive");
    expect(title()).toBe("Try a smaller plan");
    await click(button("See plans", sheet()!));
    expect(bridge.continueInBrowser).toHaveBeenCalledExactlyOnceWith({ kind: "upgrade" });
    expect(bridge.retention).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "helped", offer: "downgrade" });
    await open();
    await toWhy();
    await choose("Not using it enough");
    expect(title()).toBe("This month on dusk cloud");
    await next();
    await next();
    await click(sheet()!.querySelector("[data-cloud-cancel-confirm]"));
    expect(bridge.cancelPlan).toHaveBeenCalledExactlyOnceWith({ answer: "unused", offer: "help" });
  });

  it("Plan & billing has nothing to show for a free account", async () => {
    vi.stubGlobal("window", Object.assign(window, { duskDesktop: { cloudAccount: accountBridge({ status: "connected", account: { id: "a", email: "p@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 } }) as unknown as CloudAccountBridge } }));
    await show(createElement(PlanBillingPage));
    expect(text()).toBe("No plan to show here.");
  });
});
