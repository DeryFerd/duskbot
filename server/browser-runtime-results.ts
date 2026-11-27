import { BROWSER_INTERRUPTED, BROWSER_RESTART_TOOL } from "./browser-refusals.ts";
import type { Content, ToolResult } from "./browser/shape.ts";
export type { ToolResult };

// what a browser call answers when the browser itself did not: the words the bot reads, kept apart from the runtime
const RESTART_COST = "a restart closes every tab and loses page state such as form input";

export function stuckBrowserToolError(): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: BROWSER_INTERRUPTED }] };
}

export function lostCallToolError(call: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: `The browser did not answer this ${call} call. It may still be running, or it may already have taken effect. Do not repeat it yet: your next browser call first waits for the browser, then tells you where the page is. Call ${BROWSER_RESTART_TOOL} only if the browser stays busy, because ${RESTART_COST}.` }] };
}

export function stillBusyToolError(call: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: `The browser is still busy with an earlier ${call} call that did not answer. This call did not run. Try again in a moment. If the browser stays busy, call ${BROWSER_RESTART_TOOL}; ${RESTART_COST}.` }] };
}

export function recoveredResult(call: string, url: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: `The browser answers again: the earlier ${call} call that did not answer has ended, and it may have taken effect. This call did not run. The current page is ${url || "unknown"}. Check the page before you repeat the earlier action, then call again what you need.` }] };
}

export function toolNameOf(params: unknown): string | undefined {
  const name = (params as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : undefined;
}

export function firstText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  const part = Array.isArray(content) ? content.find((item) => typeof (item as { text?: unknown } | null)?.text === "string") : undefined;
  return part ? (part as { text: string }).text : "";
}

/** An engine answer as a batch step's result: its text and pictures. */
export function asToolResult(result: unknown): ToolResult {
  const record = result as { content?: unknown; isError?: unknown } | null;
  const content = (Array.isArray(record?.content) ? record.content as unknown[] : []).filter((part): part is Content => {
    const item = part as { type?: unknown; text?: unknown; data?: unknown } | null;
    return (item?.type === "text" && typeof item.text === "string") || (item?.type === "image" && typeof item.data === "string");
  });
  return { content, ...(record?.isError === true ? { isError: true } : {}) };
}

/** One timed browser action (ms), logged with DUSK_BROWSER_TIMING=1; `inFlight` is this session's work already running. */
export interface BrowserTiming {
  session: string;
  tool: string;
  outcome: "ok" | "error";
  totalMs: number;
  launchMs?: number;
  engineMs?: number;
  observeMs?: number;
  stepsMs?: number;
  chars?: number;
  inFlight: number;
}

export function formatBrowserTiming(timing: BrowserTiming): string {
  const parts = [`browser timing: ${timing.tool} ${timing.outcome}`];
  const phases: Array<[string, number | undefined]> = [
    ["total", timing.totalMs], ["launch", timing.launchMs], ["engine", timing.engineMs], ["observe", timing.observeMs], ["steps", timing.stepsMs],
  ];
  for (const [label, value] of phases) {
    if (value !== undefined) parts.push(`${label}=${Math.round(value)}ms`);
  }
  if (timing.chars !== undefined) parts.push(`chars=${timing.chars}`);
  parts.push(`inflight=${timing.inFlight}`, `session=${timing.session}`);
  return parts.join(" ");
}

export function resultChars(result: unknown): number {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const item of content) {
    const text = (item as { text?: unknown } | null)?.text;
    if (typeof text === "string") chars += text.length;
  }
  return chars;
}
