// @vitest-environment happy-dom
import { createElement, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState, CloudPlanBridge, CloudRenewalResult, CloudRetentionStep } from "../../electron/cloud-account.mjs";
import type { CloudUsage } from "../../electron/cloud-home.mjs";
import type { CloudRenewal } from "../../electron/cloud-list.mjs";
import { setLocale } from "@/lib/i18n";

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
  it("why, one offer, confirm, done: a reason is needed, the note and the offer go with the cancel, every step is logged, and Resume puts it back", async () => {
    const actions = actionsFor(), changed = vi.fn(), openPlans = vi.fn(async () => undefined);
    await show(createElement(CloudCancelPlan, { renewal: paid, actions, offers: { cheaper: "Plus", openPlans }, onChanged: changed }));
    const link = button("Cancel subscription")!;
    expect(link.className).toContain("underline");
    await open();
    expect(sheet()!.getAttribute("aria-modal")).toBe("true");
    expect(title()).toBe("Why are you leaving?");
    expect([...sheet()!.querySelectorAll("input[type=radio]")].map(input => input.closest("label")!.textContent))
      .toEqual(["Too expensive", "Not using it enough", "Missing a feature", "Switching to something else", "Technical problems", "Prefer not to say"]);
    expect(document.activeElement?.textContent).toBe("Keep my plan");
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
    expect([step(), title()]).toEqual(["offer", "Try a smaller plan"]);
    expect(text()).toContain("Plus costs less and keeps your bots running on dusk cloud.");
    expect(button("See plans")).toBeTruthy();
    await click(button("No thanks, continue"));
    expect(actions.retention).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "shown", offer: "downgrade", note: "Too much for a side project." });
    expect([step(), title()]).toEqual(["confirm", "Cancel your plan"]);
    expect([...sheet()!.querySelectorAll("li")].map(item => item.textContent)).toEqual(["Bots on dusk cloud stop running when your Mac is asleep or off.", "Routines on dusk cloud stop."]);
    expect(text()).toContain(`You have access until ${day(END)}.`);
    expect(text()).toContain(`Your dusk cloud files are kept until ${day(END + 30 * DAY)}, then deleted.`);
    expect(document.activeElement?.textContent).toBe("Keep my plan");
    await click(sheet()!.querySelector("[data-cloud-cancel-confirm]"));
    expect(actions.cancel).toHaveBeenCalledExactlyOnceWith({ answer: "price", offer: "downgrade", improve: "Too much for a side project." });
    expect(actions.retention).toHaveBeenCalledTimes(2);
    expect([step(), title()]).toEqual(["done", "Your subscription is cancelled"]);
    expect(sheet()!.querySelector("[role='status']")?.textContent).toBe(`You have access until ${day(END)}.`);
    expect(text()).toContain("Resume anytime before then, and nothing changes.");
    expect(changed).not.toHaveBeenCalled();
    await click(button("Resume subscription", sheet()!));
    expect(actions.keep).toHaveBeenCalledOnce();
    expect([sheet(), changed.mock.calls.length, openPlans.mock.calls.length]).toEqual([null, 1, 0]);
  });

  it("Prefer not to say counts: what you'd lose, and No thanks always goes on to the cancel", async () => {
    const actions = actionsFor();
    await show(createElement(CloudCancelPlan, { renewal: paid, actions }));
    await open();
    await choose("Prefer not to say");
    expect([step(), title(), sheet()!.getAttribute("data-cloud-cancel-offer")]).toEqual(["offer", "What you'd lose", "losses"]);
    expect([...sheet()!.querySelectorAll("li")].map(item => item.textContent)).toEqual(["Bots on dusk cloud stop running when your Mac is asleep or off.", "Routines on dusk cloud stop.",
      `Your dusk cloud files are kept until ${day(END + 30 * DAY)}, then deleted.`]);
    await next();
    expect(step()).toBe("confirm");
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
      { answer: "Switching to something else", title: "What you'd lose", offer: "losses", take: "Keep my plan", outcome: "kept" },
    ];
    for (const one of cases) {
      const actions = actionsFor();
      await show(createElement(CloudCancelPlan, { key: `${one.answer}${one.title}`, renewal: one.renewal ?? paid, actions, offers: one.offers ?? {} }));
      await open();
      await choose(one.answer);
      expect([title(), sheet()!.getAttribute("data-cloud-cancel-offer")], one.title).toEqual([one.title, one.offer]);
      if (one.says) expect(text()).toContain(one.says);
      if (one.lines) expect([...sheet()!.querySelectorAll("li")].map(item => item.textContent)).toEqual(one.lines);
      expect(button("No thanks, continue")).toBeTruthy();
      await click(button(one.take, sheet()!));
      expect(sheet(), one.title).toBeNull();
      expect(actions.retention).toHaveBeenLastCalledWith(expect.objectContaining({ step: "help", outcome: one.outcome, offer: one.offer }));
      expect(actions.cancel).not.toHaveBeenCalled();
      await act(async () => root.unmount()); root = createRoot(container);
    }
    expect(openPlans).toHaveBeenCalledOnce();
    expect(openLink.mock.calls.map(([url]) => url)).toEqual([expect.stringMatching(/^mailto:hello@dusk\.bot\?subject=Missing%20from%20dusk%20cloud$/), CANCEL_HELP_URL]);
  });

  it("Keep my plan on any step closes the sheet and logs kept; a failed cancel says so and stays; an Admin without Cancel says billing opened", async () => {
    const actions = actionsFor();
    await show(createElement(CloudCancelPlan, { renewal: paid, actions }));
    await open();
    await click(button("Keep my plan", sheet()!));
    expect([sheet(), actions.retention.mock.calls.length]).toEqual([null, 0]);
    await open();
    await choose("Switching to something else");
    await next();
    await click(button("Keep my plan", sheet()!));
    expect(actions.retention).toHaveBeenLastCalledWith({ reason: "switching", step: "confirm", outcome: "kept", offer: "losses" });
    expect([sheet(), actions.cancel.mock.calls.length, actions.keep.mock.calls.length]).toEqual([null, 0, 0]);

    const failing = actionsFor({ cancel: { outcome: "failed", state: { status: "connected" } } });
    failing.retention.mockRejectedValue(new Error("offline"));
    await show(createElement(CloudCancelPlan, { renewal: paid, actions: failing }));
    await open();
    await choose("Technical problems");
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
      openPage: vi.fn(async () => ({ opened: true })), continueInBrowser: vi.fn(async () => ({ outcome: "opened" as const, state })), retention: vi.fn(async () => true),
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
    await choose("Too expensive");
    expect(title()).toBe("Try a smaller plan");
    await click(button("See plans", sheet()!));
    expect(bridge.continueInBrowser).toHaveBeenCalledExactlyOnceWith({ kind: "upgrade" });
    expect(bridge.retention).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "helped", offer: "downgrade" });
    await open();
    await choose("Not using it enough");
    expect(title()).toBe("This month on dusk cloud");
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
