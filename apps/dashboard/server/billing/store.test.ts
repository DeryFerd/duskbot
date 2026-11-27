import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createBillingStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("rows a newer build wrote with a cancel reason, offer or step this one does not know still load", () => {
  const dir = mkdtempSync(join(tmpdir(), "billing-store-"));
  dirs.push(dir);
  const empty = { teamInvites: [], teamLeaves: [], closures: [], providerCancels: [], customers: [], checkouts: [], subscriptions: [], licenses: [], invoices: [], webhookEvents: [] };
  writeFileSync(join(dir, "billing.json"), JSON.stringify({ ...empty,
    feedback: [{ id: "f1", accountId: "a1", cloudId: null, subscriptionId: "s1", answer: "a-reason-from-later", offer: "an-offer-from-later", outcome: "an-outcome-from-later", at: 1 }],
    retention: [{ id: "r1", accountId: "a1", subscriptionId: "s1", reason: "a-reason-from-later", step: "a-step-from-later", outcome: "an-outcome-from-later", at: 1 }] }));
  const store = createBillingStore(dir);
  expect(store.state.feedback[0]!.answer).toBe("a-reason-from-later");
  expect(store.state.retention?.[0]!.step).toBe("a-step-from-later");
});
