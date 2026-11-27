import { CANCEL_ANSWERS } from "../../../../shared/billing-api.ts";
import type { RetentionInput } from "../../../../shared/billing-api.ts";

export interface CancelFlowRow { reason: string; started: number; saved: number; cancelled: number }
export interface CancelFlowSummary { started: number; saved: number; cancelled: number; discounts: number; reasons: CancelFlowRow[] }

const SAVES = new Set<RetentionInput["outcome"]>(["discount", "downgrade", "helped", "kept"]);

/** the cancel flow over [from, to): how many started it, kept their plan (a save) or cancelled, per reason, most cancels first */
export function cancelFlowSummary(entries: ReadonlyArray<RetentionInput & { at: number }>, from: number, to: number): CancelFlowSummary {
  const rows = new Map<string, CancelFlowRow>(CANCEL_ANSWERS.map(reason => [reason, { reason, started: 0, saved: 0, cancelled: 0 }]));
  let discounts = 0;
  for (const entry of entries) {
    if (entry.at < from || entry.at >= to) continue;
    const row = rows.get(entry.reason);
    if (!row) continue;
    if (entry.step === "reason" && entry.outcome === "shown") row.started++;
    else if (entry.outcome === "cancelled") row.cancelled++;
    else if (SAVES.has(entry.outcome)) row.saved++;
    if (entry.outcome === "discount") discounts++;
  }
  const reasons = [...rows.values()].filter(row => row.started + row.saved + row.cancelled > 0).sort((a, b) => b.cancelled - a.cancelled || b.started - a.started);
  const sum = (key: "started" | "saved" | "cancelled") => reasons.reduce((total, row) => total + row[key], 0);
  return { started: sum("started"), saved: sum("saved"), cancelled: sum("cancelled"), discounts, reasons };
}

export interface CancelSaves { saved: number; cancelled: number; rate: number | null }
type FlowEntry = Pick<RetentionInput, "step" | "outcome"> & { subscriptionId: string; at: number };
/** a step this long after the last one starts a new cancel flow */
const FLOW_GAP_MS = 6 * 3_600_000;
/** a save ends its flow; a cancel does not, so a restart right after it (confirm, kept) makes that flow a save */
const ENDS_FLOW = new Set<RetentionInput["outcome"]>(["kept", "discount", "downgrade"]);

/** cancel flows (one plan's steps, split after a save, where a new reason was given after an answer, or six quiet hours)
 *  that ended in [from, to): saved when the last thing in the flow was not a cancel. `rate`: saved / (saved + cancelled) */
export function cancelSaves(entries: ReadonlyArray<FlowEntry>, from: number, to: number): CancelSaves {
  const sorted = [...entries].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId) || a.at - b.at);
  let saved = 0, cancelled = 0, flow: FlowEntry[] = [];
  const close = () => {
    const last = flow.at(-1);
    if (last && last.at >= from && last.at < to) { if (flow.filter(entry => entry.outcome !== "shown").at(-1)?.outcome === "cancelled") cancelled++; else saved++; }
    flow = [];
  };
  for (const entry of sorted) {
    const previous = flow.at(-1);
    if (previous && (previous.subscriptionId !== entry.subscriptionId || entry.at - previous.at > FLOW_GAP_MS || ENDS_FLOW.has(previous.outcome)
      || (entry.step === "reason" && entry.outcome === "shown" && flow.some(item => item.outcome !== "shown")))) close();
    flow.push(entry);
  }
  close();
  return { saved, cancelled, rate: saved + cancelled > 0 ? saved / (saved + cancelled) : null };
}
