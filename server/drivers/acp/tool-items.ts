import { toolDetailPreview } from "../../tool-summary.ts";

export type AcpToolEndEvent = { type: "item.completed"; itemType: "tool"; itemId: string | undefined; ok: boolean; output?: string };

/**
 * The events that end a finished tool item. An item already in `ended` gets none, and an item that ends here joins it:
 * ACP v1 lets an update name a tool call that already finished. A picture in the result (a screenshot) is what the tool
 * showed the model; it stays in the step, and the agent shares one on purpose with its own message or attach_file.
 */
export function acpToolEndEvents(
  update: { status?: unknown; rawOutput?: unknown; content?: unknown },
  itemId: string | undefined,
  ended: Set<string>,
): AcpToolEndEvent[] {
  if (itemId !== undefined) {
    if (ended.has(itemId)) return [];
    ended.add(itemId);
  }
  return [{ type: "item.completed", itemType: "tool", itemId, ok: update.status !== "failed", output: toolDetailPreview(update.rawOutput ?? update.content) }];
}
