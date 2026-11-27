// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BillingOverview, Selection } from "../data/contracts";
import { fixtureCatalog } from "../data/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plus: Selection = { license: "personal", members: 1, desktop: "shared-s", size: null, region: "eu-central", interval: "month" };
const pro: Selection = { license: "starter", members: 1, desktop: "shared-m", size: null, region: "eu-central", interval: "month" };
const billingFor = (selection: Selection, offer = true): BillingOverview => ({
  subscription: { id: "sub", bundle: null, selection, status: "active", amountUsd: 20, currentPeriodEnd: Date.UTC(2026, 11, 13), cancelAt: null },
  paymentMethod: null, invoices: [], retention: { offer: offer ? { percent: 30, cycles: 3 } : null, applied: null },
});
const state = vi.hoisted(() => ({
  cloud: {} as Record<string, unknown>,
  session: { toast: (_message: string) => {} },
  usage: { month: { totals: { turns: 42 } }, bots: [{ bot: { routines: [{}, {}, {}] } }, { bot: { routines: [] } }], loading: false },
}));
vi.mock("../data/cloud", () => ({ useCloud: () => state.cloud }));
vi.mock("../data/session", () => ({ useSession: () => state.session }));
vi.mock("../data/usage", () => ({ useAccountUsage: () => state.usage }));

const makeSpies = () => ({ cancel: vi.fn(async (_survey: object | null) => {}), keep: vi.fn(async () => {}), changePlan: vi.fn(async (_selection: Selection, _approved?: number) => {}), retentionStep: vi.fn((_input: object) => {}),
  takeDiscount: vi.fn(async (_reason: string) => {}), updateCard: vi.fn(async () => {}), onClose: vi.fn(() => {}) });
let spies = makeSpies();
beforeEach(() => { spies = makeSpies(); });
const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function open(selection: Selection, offer = true) {
  state.cloud = { billing: billingFor(selection, offer), ...spies };
  const { CancelFlow } = await import("./cancel-flow");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(createElement(CancelFlow, { open: true, onClose: () => spies.onClose(), catalog: fixtureCatalog })));
}
const title = () => document.querySelector("[role=dialog] h2")?.textContent;
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
const click = async (label: string) => { const b = button(label); expect(b, label).not.toBeNull(); await act(async () => b!.click()); };
const pick = async (label: string) => {
  const input = [...document.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent === label)?.querySelector("input");
  expect(input, label).toBeTruthy();
  await act(async () => input!.click());
};

test("the plan page shows free until someone is on a cloud plan, then plus, pro and team", async () => {
  const { tiersFor } = await import("./Billing");
  expect(tiersFor(false)).toEqual(["free", "starter", "pro"]);
  expect(tiersFor(true)).toEqual(["starter", "pro", "team"]);
});

const text = () => document.body.textContent ?? "";
const type = async (value: string) => {
  const box = document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
/** the reason step, a reason picked, then on to its one offer */
const toOffer = async (reason: string) => { expect(title()).toBe("why are you leaving?"); await pick(reason); await click("continue"); };

test("the reason is required: continue with nothing picked says so and stays; prefer not to say counts", async () => {
  await open(plus);
  expect(title()).toBe("why are you leaving?");
  expect(document.querySelector("[role=alert]")).toBeNull();
  await click("continue");
  expect(title()).toBe("why are you leaving?");
  expect(document.querySelector("[role=alert]")?.textContent).toBe("pick one, or choose prefer not to say.");
  expect(spies.retentionStep).not.toHaveBeenCalled();
  await pick("prefer not to say");
  expect(document.querySelector("[role=alert]")).toBeNull();
  await click("continue");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "skip", step: "reason", outcome: "shown", offer: "losses" });
  expect(title()).toBe("what you'd lose");
  expect(text()).toContain("your 2 bots stop working when your mac sleeps");
  expect(text()).toContain("your 3 routines only run while your mac is awake");
  expect(text()).toContain("your dusk cloud files are kept until 12 Jan 2027, then deleted");
});

test("the note is optional and labelled", async () => {
  await open(plus);
  const box = document.querySelector("textarea")!;
  expect(document.querySelector(`label[for="${box.id}"]`)?.textContent).toBe("anything else you'd like us to know? (optional)");
  await toOffer("i'm switching to something else");
  expect(title()).toBe("what you'd lose");
});

test("keep my plan on the reason step closes, and logs kept once a reason is picked", async () => {
  await open(plus);
  await click("keep my plan");
  expect(spies.onClose).toHaveBeenCalledTimes(1);
  expect(spies.retentionStep).not.toHaveBeenCalled();
  await pick("it's too expensive");
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "reason", outcome: "kept", offer: "discount" });
});

test("too expensive: one offer, the discount, which can be taken", async () => {
  await open(pro);
  await toOffer("it's too expensive");
  expect(title()).toBe("keep it for less");
  expect(text()).toContain("30% off your next 3 months");
  expect(button("switch to plus")).toBeNull();
  await click("take 30% off");
  expect(spies.takeDiscount).toHaveBeenCalledWith("price");
  expect(spies.cancel).not.toHaveBeenCalled();
});

test("too expensive on pro without the discount: plus instead, logged as a downgrade", async () => {
  await open(pro, false);
  await toOffer("it's too expensive");
  expect(button("take 30% off")).toBeNull();
  await click("switch to plus");
  expect(spies.changePlan).toHaveBeenCalledWith(expect.objectContaining({ desktop: "shared-s", license: "starter" }), 0);
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "downgrade", offer: "downgrade" });
});

test("too expensive on the smallest plan with no discount: personal use stays free, and no thanks goes on", async () => {
  await open(plus, false);
  await toOffer("it's too expensive");
  expect(title()).toBe("free stays free");
  expect(text()).toContain("personal use on your mac stays free");
  await click("no thanks, continue");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "shown", offer: "none" });
  expect(title()).toBe("cancel your plan?");
});

test("not using it enough: what the bots did, with the discount when there is one, else ways to get more out of it", async () => {
  await open(plus);
  await toOffer("i'm not using it enough");
  expect(title()).toBe("your bots this month");
  expect(text()).toContain("this month your 2 bots took 42 turns.");
  expect(text()).toContain("30% off your next 3 months");
  expect(document.querySelector('a[href="/bots"]')).toBeNull();
  await click("no thanks, continue");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "unused", step: "help", outcome: "shown", offer: "discount" });
});

test("not using it enough without a discount: the links, and following one is logged as helped", async () => {
  await open(plus, false);
  await toOffer("i'm not using it enough");
  expect(button("take 30% off")).toBeNull();
  const link = document.querySelector<HTMLAnchorElement>('a[href="/bots"]')!;
  expect(link).toBeTruthy();
  await act(async () => link.click());
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "unused", step: "help", outcome: "helped", offer: "help" });
});

test("technical problems: fix links, and keeping the plan from the offer is logged", async () => {
  await open(plus);
  await toOffer("i'm having technical problems");
  expect(title()).toBe("let's fix it");
  expect([...document.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(expect.arrayContaining(["/cloud", "/workspaces", expect.stringMatching(/^mailto:hello@dusk\.bot/)]));
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "broken", step: "help", outcome: "kept", offer: "help" });
  expect(spies.onClose).toHaveBeenCalled();
});

test("missing a feature: tell us and we'll reply, the note goes into the mail", async () => {
  await open(plus);
  await type("a linux app");
  await toOffer("it's missing a feature i need");
  expect(title()).toBe("tell us what's missing");
  const mail = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href")?.startsWith("mailto:"))!;
  expect(mail.getAttribute("href")).toContain(`body=${encodeURIComponent("a linux app")}`);
  await act(async () => mail.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "feature", step: "help", outcome: "helped", offer: "note", note: "a linux app" });
});

test("switching: what you'd lose, then no thanks, confirm and cancel with the survey; done shows the access date and restarts", async () => {
  await open(plus);
  await type("going elsewhere");
  await toOffer("i'm switching to something else");
  await click("no thanks, continue");
  expect(title()).toBe("cancel your plan?");
  expect(text()).toContain("your plan ends on 13 Dec 2026, not today");
  expect(text()).toContain("your dusk cloud files are kept until 12 Jan 2027, then deleted");
  await click("cancel subscription");
  expect(spies.cancel).toHaveBeenCalledWith({ answer: "switching", offer: "losses", improve: "going elsewhere" });
  expect(title()).toBe("your plan is cancelled");
  expect(text()).toContain("you have access until 13 Dec 2026.");
  await click("restart plan");
  expect(spies.keep).toHaveBeenCalled();
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "switching", step: "confirm", outcome: "kept", offer: "losses" });
  expect(spies.onClose).toHaveBeenCalled();
});

test("keep my plan on the confirm step is logged as kept and cancels nothing", async () => {
  await open(plus);
  await toOffer("prefer not to say");
  await click("no thanks, continue");
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "skip", step: "confirm", outcome: "kept", offer: "losses" });
  expect(spies.cancel).not.toHaveBeenCalled();
});

test("every reason reaches its offer, then confirm, with no thanks", async () => {
  for (const [label, offer] of [["it's too expensive", "discount"], ["i'm not using it enough", "discount"], ["it's missing a feature i need", "note"], ["i'm switching to something else", "losses"], ["i'm having technical problems", "help"], ["prefer not to say", "losses"]] as const) {
    spies = makeSpies();
    await open(plus);
    await toOffer(label);
    expect(spies.retentionStep).toHaveBeenLastCalledWith(expect.objectContaining({ step: "reason", outcome: "shown", offer }));
    await click("no thanks, continue");
    expect(title()).toBe("cancel your plan?");
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.innerHTML = "";
  }
});

test("a plan with a work license ends only the dusk cloud", async () => {
  await open(pro);
  await toOffer("prefer not to say");
  expect(text()).toContain("your dusk cloud keeps working until 13 Dec 2026. your work license stays.");
  await click("no thanks, continue");
  expect(title()).toBe("cancel your dusk cloud?");
  await click("cancel dusk cloud");
  expect(spies.changePlan).toHaveBeenCalledWith({ ...pro, desktop: "none", size: null });
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "skip", step: "confirm", outcome: "cancelled", offer: "losses" });
  expect(spies.cancel).not.toHaveBeenCalled();
  expect(title()).toBe("your dusk cloud is cancelled");
  expect(text()).toContain("your dusk cloud works until 13 Dec 2026");
});

test("pro on a free trial cancels the whole plan at the trial's end, never a plan change that bills at once", async () => {
  const until = Date.now() + 3 * 86_400_000;
  const billing = billingFor(pro, false);
  billing.subscription = { ...billing.subscription!, currentPeriodEnd: until, trialEndsAt: until };
  state.cloud = { billing, ...spies };
  const { CancelFlow } = await import("./cancel-flow");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(createElement(CancelFlow, { open: true, onClose: () => spies.onClose(), catalog: fixtureCatalog })));
  await toOffer("it's too expensive");
  expect(button("switch to plus")).toBeNull();
  await click("no thanks, continue");
  expect(title()).toBe("cancel your plan?");
  expect(text()).toContain("you won't be charged. after that:");
  expect(text()).not.toContain("work license stays");
  await click("cancel subscription");
  expect(spies.cancel).toHaveBeenCalledWith({ answer: "price", offer: "none" });
  expect(spies.changePlan).not.toHaveBeenCalled();
});

test("a past-due plan offers to update the card on the reason step", async () => {
  const billing = billingFor(plus);
  billing.subscription = { ...billing.subscription!, status: "past_due" };
  state.cloud = { billing, ...spies };
  const { CancelFlow } = await import("./cancel-flow");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(createElement(CancelFlow, { open: true, onClose: () => spies.onClose(), catalog: fixtureCatalog })));
  await click("update your card instead");
  expect(spies.updateCard).toHaveBeenCalled();
});
