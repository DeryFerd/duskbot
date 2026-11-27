// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { BillingOverview, Selection } from "../data/contracts";
import { fixtureCatalog } from "../data/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pro: Selection = { license: "starter", members: 1, desktop: "shared-m", size: null, region: "eu-central", interval: "month" };
const billingWith = (cancelAt: number | null): BillingOverview => ({
  subscription: { id: "sub", bundle: "pro", selection: pro, status: "active", amountUsd: 50, currentPeriodEnd: Date.UTC(2026, 11, 13), cancelAt },
  paymentMethod: { brand: "Visa", last4: "4242", expMonth: 9, expYear: 2029 }, invoices: [], retention: { offer: null, applied: null },
});
const state = vi.hoisted(() => ({ cloud: {} as Record<string, unknown> }));
vi.mock("../data/cloud", () => ({ useCloud: () => state.cloud }));
vi.mock("../data/session", () => ({ useSession: () => ({ toast: () => {} }) }));
vi.mock("../data/quote", () => ({ useCart: () => ({ cart: null }) }));
vi.mock("../data/usage", () => ({ useAccountUsage: () => ({ month: null, bots: [], loading: false }) }));

const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; });

async function render(billing: BillingOverview, keep = vi.fn(async () => {})) {
  state.cloud = { catalog: fixtureCatalog, billing, clouds: [], keep, updateCard: vi.fn(async () => {}), changePlan: vi.fn(async () => {}), retentionStep: vi.fn(), cancel: vi.fn(async () => {}), takeDiscount: vi.fn(async () => {}), checkout: vi.fn(async () => true) };
  const { PlanBilling } = await import("./plan-billing");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(createElement(PlanBilling)));
  return keep;
}
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;

test("plan & billing sits at #billing and ends with a quiet cancel that opens the flow; no manage subscription", async () => {
  await render(billingWith(null));
  expect(document.getElementById("billing")?.querySelector("h2")?.textContent).toBe("plan & billing");
  expect(button("manage subscription")).toBeNull();
  expect(button("update")).not.toBeNull();
  const cancel = button("cancel subscription")!;
  expect(cancel).not.toBeNull();
  expect([...document.getElementById("billing")!.querySelectorAll("button")].at(-1)).toBe(cancel);
  await act(async () => cancel.click());
  expect(document.querySelector("[role=dialog] h2")?.textContent).toBe("why are you leaving?");
});

test("a plan already set to end shows restart instead of cancel", async () => {
  const keep = await render(billingWith(Date.UTC(2026, 11, 13)));
  expect(button("cancel subscription")).toBeNull();
  await act(async () => button("restart plan")!.click());
  expect(keep).toHaveBeenCalled();
});
