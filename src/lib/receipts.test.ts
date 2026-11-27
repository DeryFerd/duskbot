import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { trailingRows } from "./failed-reply";
import { isReceipt, lastNonReceipt } from "./receipts";

const row = (id: string, patch: Partial<Message>): Message => ({ id, role: "bot", kind: "text", at: 1, ...patch } as Message);

describe("the line /new leaves", () => {
  const started = row("n", { kind: "activity", tool: { name: "recovery: New session started", ok: true, newSession: true } });

  it("is a record: never the chat's newest news, so no notice card, sidebar line or mascot reads it", () => {
    expect(isReceipt(started)).toBe(true);
    expect(lastNonReceipt([row("a", { text: "hi" }), started])?.id).toBe("a");
    expect(trailingRows([started]).notices).toEqual([]);
  });

  it("leaves every other quiet line as it was", () => {
    const carryOn = row("r", { kind: "activity", tool: { name: "recovery: Reconnected, carrying on", ok: true } });
    expect(isReceipt(carryOn)).toBe(false);
    expect(trailingRows([carryOn]).notices.map((m) => m.id)).toEqual(["r"]);
  });
});
