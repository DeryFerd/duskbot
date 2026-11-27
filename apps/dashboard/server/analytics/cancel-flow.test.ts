import { expect, it } from "vitest";
import { cancelFlowSummary, cancelSaves } from "./cancel-flow.ts";

it("counts cancel flow starts, saves and cancels per reason inside the window, most cancels first", () => {
  const at = 1000;
  const summary = cancelFlowSummary([
    { reason: "price", step: "reason", outcome: "shown", at },
    { reason: "price", step: "help", outcome: "discount", at },
    { reason: "broken", step: "reason", outcome: "shown", at },
    { reason: "broken", step: "help", outcome: "helped", at },
    { reason: "broken", step: "confirm", outcome: "cancelled", at },
    { reason: "switching", step: "confirm", outcome: "cancelled", at },
    { reason: "switching", step: "confirm", outcome: "cancelled", at: 5000 },
    { reason: "unused", step: "reason", outcome: "shown", at: 10 },
  ], 500, 2000);
  expect(summary).toEqual({ started: 2, saved: 2, cancelled: 2, discounts: 1, reasons: [
    { reason: "broken", started: 1, saved: 1, cancelled: 1 },
    { reason: "switching", started: 0, saved: 0, cancelled: 1 },
    { reason: "price", started: 1, saved: 1, cancelled: 0 },
  ] });
});

it("save rate: saved flows over saved and cancelled flows that ended in the window, a flow saved unless its last answer was a cancel", () => {
  const h = 3_600_000, row = (subscriptionId: string, step: "reason" | "help" | "confirm", outcome: "shown" | "discount" | "downgrade" | "helped" | "kept" | "cancelled", at: number) => ({ subscriptionId, step, outcome, at });
  const entries = [
    // saved with the discount
    row("a", "reason", "shown", 10 * h), row("a", "help", "discount", 10 * h + 1),
    // helped, then cancelled anyway: one cancelled flow
    row("b", "reason", "shown", 10 * h), row("b", "help", "helped", 10 * h + 1), row("b", "confirm", "cancelled", 10 * h + 2),
    // kept once, came back a day later and cancelled: one saved and one cancelled
    row("c", "reason", "shown", 10 * h), row("c", "confirm", "kept", 10 * h + 1), row("c", "reason", "shown", 40 * h), row("c", "confirm", "cancelled", 40 * h + 1),
    // looked and closed it: not a cancel
    row("d", "reason", "shown", 11 * h),
    // a desktop cancel with no steps before it
    row("e", "confirm", "cancelled", 12 * h),
    // ended before the window
    row("f", "reason", "shown", 0), row("f", "confirm", "cancelled", 1),
  ];
  expect(cancelSaves(entries, 5 * h, 50 * h)).toEqual({ saved: 3, cancelled: 3, rate: 0.5 });
  expect(cancelSaves(entries, 0, 5 * h)).toEqual({ saved: 0, cancelled: 1, rate: 0 });
  expect(cancelSaves([], 0, 1)).toEqual({ saved: 0, cancelled: 0, rate: null });
});
