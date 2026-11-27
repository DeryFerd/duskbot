import { describe, expect, it } from "vitest";
import { lastPreviewable } from "@/components/sidebar-preview";
import { isAutoSummaryRow } from "./auto-summary";

const line = "Summarized this conversation while it was idle; the latest messages carry on word for word";

describe("the warm summary's line", () => {
  it("is hidden whether marked or written before the mark, and nothing else is", () => {
    expect(isAutoSummaryRow({ kind: "activity", autoSummary: true, tool: { name: "anything" } })).toBe(true);
    expect(isAutoSummaryRow({ kind: "activity", tool: { name: line } })).toBe(true);
    expect(isAutoSummaryRow({ kind: "activity", tool: { name: "Bash" } })).toBe(false);
    expect(isAutoSummaryRow({ kind: "text", tool: { name: line } })).toBe(false);
  });

  it("never becomes the chat's preview", () => {
    const reply = { id: "r", kind: "text", role: "bot", text: "Booked it." };
    expect(lastPreviewable([reply, { id: "w", kind: "activity", role: "bot", autoSummary: true as const, tool: { name: line } }])).toBe(reply);
  });
});
