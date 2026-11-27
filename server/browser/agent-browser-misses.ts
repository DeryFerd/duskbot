// What agent-browser 0.37.0 answers when a call names an element it cannot act on, and what the bot is told instead.
// It acts at once, so an element a page adds a moment later (a list that loads, a button after a fetch) is "Element not
// found" where Playwright, which models expect, would have waited. And a ref from a snapshot the page has moved on from
// is "Unknown ref: e9" or "Could not locate element with role=button name=Next", which says nothing of what to do next.

type Args = Record<string, unknown>;

/** How long an action waits for an element that is not on the page yet. */
export const LATE_ELEMENT_MS = 5_000;

/** Calls that act on or read one element named by `selector`. */
const ELEMENT_CALLS: ReadonlySet<string> = new Set(["click", "fill", "type", "check", "uncheck", "select", "get_text", "scroll", "screenshot"]
  .map((name) => `agent_browser_${name}`));
const REF = /^@?(e\d{1,6})$/u;

const failedText = (result: unknown): string | null => {
  const record = result as { isError?: unknown; content?: unknown } | null;
  if (record?.isError !== true || !Array.isArray(record.content)) return null;
  const part = (record.content as Array<{ type?: unknown; text?: unknown }>).find((item) => item?.type === "text" && typeof item.text === "string");
  return part ? String(part.text) : null;
};

/** The selector a call named when the engine found nothing for it on the page; refs and page selectors are not. */
export function missingElement(name: string, args: Args | undefined, result: unknown): string | null {
  const selector = args?.selector;
  if (!ELEMENT_CALLS.has(name) || typeof selector !== "string" || REF.test(selector.trim()) || selector.startsWith("[data-dusk-pick=")) return null;
  return failedText(result)?.startsWith(`Element not found: ${selector}`) ? selector : null;
}

export const lateElementMissing = (selector: string, waitedMs: number): string =>
  `Element not found: nothing on the page matches ${selector}, after waiting ${Math.max(1, Math.round(waitedMs / 1_000))} s for it to show, so this call did nothing. ` +
  "Check the page with agent_browser_snapshot and act on a ref from it, or name the element by its text (text=Save).";

/** The ref a call named when it was from a snapshot the page has moved on from. */
export function staleRef(name: string, args: Args | undefined, result: unknown): string | null {
  const ref = typeof args?.selector === "string" ? REF.exec(args.selector.trim())?.[1] : undefined;
  if (!ref || !name.startsWith("agent_browser_")) return null;
  const text = failedText(result);
  return text && (text.startsWith(`Unknown ref: ${ref}`) || text.startsWith("Could not locate element with role=")) ? ref : null;
}

/** `fresh`: the page's snapshot follows, with refs that apply now. */
export const staleRefText = (ref: string, fresh: boolean): string =>
  `${ref} is not on the page now: the page changed since the snapshot that ref came from, so this call did nothing. ` +
  (fresh ? "The page now, with fresh refs (earlier refs no longer apply):" : "Use a ref from the page's latest snapshot.");
