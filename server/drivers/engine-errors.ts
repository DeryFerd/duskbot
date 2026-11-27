// Plain words for an engine's failure, shared by every driver: an account out of credits, a usage or rate limit, an
// overloaded or failing service, or any other HTTP refusal names the provider and keeps its own short reason. Each
// sentence keeps the words classifyError (retry.ts) reads, so retries, account switching and health codes are unchanged.
import { redactSecretsInText } from "../redact.ts";
import { hostTimeZone } from "../turn-clock.ts";
import { toolCountLimitFromError } from "../tool-count-limit.ts";
import { USAGE_LIMIT } from "./retry.ts";
import { usageLimitWait } from "./acp/quiet-status.ts";

export type EngineFailureKind = "credits" | "usage_limit" | "rate_limit" | "overloaded" | "server" | "tool_schema" | "tool_count" | "refused" | "network" | "session_id";

/** No answer at all from the provider: the Anthropic SDK's "Request timed out." and "Connection error.", Node's errno codes. */
const NETWORK = /\b(?:request timed out|connection error|network error|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i;

/** A provider refusing for want of credit or payment, in its own words (402 is read from the status). */
const OUT_OF_CREDITS = /\bpayment required\b|\binsufficient (?:account )?(?:funds|balance|credits?)\b|\b(?:credit|account) balance is too low\b|\bout of credits?\b|\bno credits? (?:left|remaining)\b|\bused all (?:available |of (?:your|its) )?credits\b/i;

/** A provider refusing a tool's parameters schema: Moonshot's "tools.function.parameters is not a valid moonshot flavored
 * json schema, details: <At path 'root': schema exceeds maximum allowed size>", OpenAI's "Invalid schema for function
 * 'x'", Anthropic's "tools.3.custom.input_schema: …", Gemini's "function_declarations[3].parameters", Bedrock's
 * "toolSpec.inputSchema". */
const TOOL_SCHEMA = /moonshot flavou?red json schema|schema exceeds maximum allowed size|invalid schema for function\b|\btools\.\d+\.custom\.input_schema\b|function_declarations\[\d+\]\.parameters|\btoolSpec\.inputSchema\b/i;
const SCHEMA_TOOL_NAME = /\b(?:function|tool) ['"`]([\w.:-]{1,128})['"`]/i;
const SCHEMA_TOO_LARGE = /exceeds maximum allowed size|\btoo (?:large|long|big)\b/i;

/** OpenCode Go's 400 for a request without a usable `x-opencode-session` (type MissingSessionID): every OpenCode build
 * the app installs sends one, so the copy that ran is an older or other OpenCode found on this computer. */
const MISSING_SESSION_ID = /\bMissingSessionID\b|\bmissing x-opencode-session\b/i;

/** Grok Build's "API error (status 402 Payment Required): …" (inside ACP's "Internal error: …"), the chat-completions
 * drivers' "xAI HTTP 402: …", and Claude Code's "API Error: 529 …". */
const STATUS = /\(status (\d{3})\b[^)]*\)|\bHTTP (\d{3})\b|^API Error:? (\d{3})\b/i;

const WRAPPERS = [
  /^provider returned a(?: streaming)? completion error:\s*/i,
  /^internal error:\s*/i,
  /^API error \(status \d{3}[^)]*\):?\s*/i,
  /^API Error:?\s*(?:\d{3}\b:?\s*)?/i,
  /^[\w.-]+ HTTP \d{3}:?\s*/i,
];
/** acpRpcError's method context: "(session/prompt, service: session, APIError)". */
const ACP_CONTEXT = /\s*\([a-z_]+\/[\w/.-]+(?:, [^()]*)?\)$/i;
const REASON_CHARS = 160;

export function httpStatusOf(text: string): number | null {
  const match = STATUS.exec(text.trim());
  const status = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function jsonMessage(body: string): string | null {
  try {
    const value = JSON.parse(body);
    const message = value?.error?.message ?? value?.message ?? (typeof value?.error === "string" ? value.error : undefined);
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

/** A status line's own phrase ("Payment Required", "Overloaded"): it says nothing the sentence does not. */
const STATUS_PHRASE = /^(?:[A-Z][a-z]+ ?){1,4}$|^\S+$/;

/** The provider's own short reason inside a raw error, without the RPC wrapper, status line or method context: its
 * first sentence, redacted, and null for a bare status phrase, a raw body or nothing at all. */
export function providerReason(text: string): string | null {
  let reason = text.replace(/\s+/g, " ").trim();
  for (const wrapper of WRAPPERS) reason = reason.replace(wrapper, "");
  reason = reason.replace(ACP_CONTEXT, "").trim();
  if (/^[{[]/.test(reason)) reason = jsonMessage(reason)?.replace(/\s+/g, " ").trim() ?? "";
  if (!reason || reason.startsWith("<")) return null;
  const first = /^(.{20,}?[.!?])\s/.exec(reason)?.[1];
  if (first) reason = first;
  if (reason.length > REASON_CHARS) reason = `${reason.slice(0, REASON_CHARS - 1).replace(/\s+\S*$/, "")}…`;
  reason = redactSecretsInText(reason).replaceAll('"', "'").replace(/[.\s]+$/, "");
  return reason && !STATUS_PHRASE.test(reason) ? reason : null;
}

/** What a raw engine failure is, from its HTTP status or its words; null when it is none of these. */
export function engineFailureKind(text: string, status = httpStatusOf(text)): EngineFailureKind | null {
  if (MISSING_SESSION_ID.test(text)) return "session_id";
  if (status === 402 || OUT_OF_CREDITS.test(text)) return "credits";
  if (USAGE_LIMIT.test(text)) return "usage_limit";
  if (status === 529 || /\boverloaded\b/i.test(text)) return "overloaded";
  if (status === 429) return "rate_limit";
  if (TOOL_SCHEMA.test(text)) return "tool_schema";
  if (toolCountLimitFromError(text) !== undefined) return "tool_count";
  if (status !== null) return status >= 500 ? "server" : "refused";
  if (NETWORK.test(text)) return "network";
  return null;
}

/** `text` in plain words naming `provider`, or null when it is no failure this knows (the caller keeps the text). */
export function engineFailureMessage(
  provider: string,
  text: string,
  { kind, status, resetsAt, timeZone }: { kind?: EngineFailureKind | null; status?: number | null; resetsAt?: number; timeZone?: string } = {},
): string | null {
  const http = status === undefined ? httpStatusOf(text) : status;
  const what = kind ?? engineFailureKind(text, http);
  if (!what) return null;
  const reason = providerReason(text);
  const says = reason ? `${provider} says: "${reason}"` : null;
  const detail = (...parts: Array<string | null>) => parts.some(Boolean) ? ` (${parts.filter(Boolean).join("; ")})` : "";
  const code = http ? `HTTP ${http}` : null;
  switch (what) {
    case "credits": return `Your ${provider} account is out of credits${detail(says)}. Add credits with ${provider}, then run it again.`;
    case "usage_limit": return resetsAt
      ? `This ${provider} account has reached its usage limit${detail(says)}, which resets ${limitResetTime(resetsAt, timeZone)}. Until then, switch this bot to another AI.`
      : `This ${provider} account has reached its usage limit${detail(says)}. Wait for it to reset, or switch this bot to another AI.`;
    case "rate_limit": return `${provider} hit a rate limit${detail(code, says)}. Wait a minute, then run it again.`;
    case "overloaded": return `${provider} is overloaded right now${detail(code, says)}. This is usually temporary, so try again in a few minutes.`;
    case "server": return `${provider} had a temporary server problem${detail(code, says)}. Try again in a few minutes.`;
    case "tool_schema": {
      const tool = SCHEMA_TOOL_NAME.exec(text)?.[1];
      const problem = SCHEMA_TOO_LARGE.test(text) ? "is too large" : `uses a form ${provider} does not accept`;
      return `${provider} refused this turn as an invalid request because the input schema of ${tool ? `the "${tool}" tool` : "one of this bot's tools"} `
        + `${problem}, so nothing ran. Turn off the MCP server or app that tool comes from for this bot, or switch the bot to another AI.`;
    }
    case "tool_count": return `${provider} refused this turn because this model takes at most ${toolCountLimitFromError(text) ?? "a limited number of"} tools `
      + "and this bot offers more, even with its tool lists trimmed, so nothing ran. Turn off some of this bot's apps or MCP servers, or switch the bot to another model.";
    case "session_id": return `OpenCode Go refused this turn because the request carried no session id, which Go requires. `
      + "The OpenCode on this computer is likely out of date: update it with `opencode upgrade`, then run it again, or switch this bot to an OpenCode Zen model.";
    case "refused": return `${provider} stopped with an error${detail(code, says)}.`;
    case "network": return /\b(?:timed out|ETIMEDOUT)\b/i.test(text)
      ? `${provider} did not answer in time (the request timed out). Check the internet connection, then run it again.`
      : `${provider} could not be reached (a network error). Check the internet connection, then run it again.`;
  }
}

const DURATION_PART = /(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|ms|milliseconds?|m|mins?|minutes?|s|secs?|seconds?)(?![a-z])/gi;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };

function durationMs(text: string): number | undefined {
  let total = 0, found = false;
  for (const [, amount, unit] of text.matchAll(DURATION_PART)) {
    total += Number(amount) * UNIT_MS[unit!.toLowerCase().replace(/^(?:hrs?|hours?)$/, "h").replace(/^(?:mins?|minutes?)$/, "m").replace(/^(?:secs?|seconds?)$/, "s").replace(/^days?$/, "d").replace(/^milliseconds?$/, "ms")]!;
    found = true;
  }
  return found && total > 0 ? total : undefined;
}

/** `x-ratelimit-reset` is epoch seconds, epoch ms, an ISO time or a duration ("1m30s"), depending on the provider. */
function headerResetAt(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const number = Number(trimmed);
    if (number > 1e12) return number;
    if (number > 1e9) return number * 1000;
    return now + number * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return parsed;
  const span = durationMs(trimmed);
  return span === undefined ? undefined : now + span;
}

/** A clock time in this computer's local time: today, or tomorrow once today's has passed. */
function clockResetAt(hour: number, minute: number, meridiem: string | undefined, now: number): number | undefined {
  if (hour > 23 || minute > 59 || (meridiem && (hour < 1 || hour > 12))) return undefined;
  const hours = meridiem ? (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0) : hour;
  const at = new Date(now).setHours(hours, minute, 0, 0);
  return at > now ? at : at + 86_400_000;
}

/** When a limit refusal's own words say it resets, for engines whose structured reset was not read: an HTTP
 * `Retry-After` (seconds or an HTTP date), `retry-after-ms`, `x-ratelimit-reset*`, "try again in 2h 5m", "resets in 40
 * minutes", "resets at 3:40 PM", "resets 3pm". Undefined when they name none, or one already past. */
export function limitResetFromWords(text: string, now = Date.now()): number | undefined {
  const pick = (at: number | undefined) => (at !== undefined && Number.isFinite(at) && at > now ? Math.round(at) : undefined);
  const ms = /\bretry-after-ms[=:]\s*(\d+)/i.exec(text);
  if (ms) return pick(now + Number(ms[1]));
  const header = /\bx-ratelimit-reset(?:-[a-z]+)?["']?\s*[:=]\s*["']?([^"',;\n]+)/i.exec(text);
  if (header) return pick(headerResetAt(header[1]!, now));
  const retryAfter = /\bretry-after["']?\s*[:=]\s*["']?([^"';\n]+)/i.exec(text);
  if (retryAfter) {
    const value = retryAfter[1]!.trim();
    return pick(/^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value));
  }
  // Google's RetryInfo detail, which its RESOURCE_EXHAUSTED message may not put in words
  const retryInfo = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  if (retryInfo) return pick(now + Number(retryInfo[1]) * 1000);
  const within = /\b(?:try again|resets?|available again|retry)\s+in\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?){1,4})/i.exec(text);
  if (within) return pick((() => { const span = durationMs(within[1]!); return span === undefined ? undefined : now + span; })());
  const clock = /\b(?:try again|resets?)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) return pick(clockResetAt(Number(clock[1]), Number(clock[2] ?? 0), clock[3], now));
  return undefined;
}

/** When a usage limit resets, in `timeZone` with its name, or in UTC when the zone is unknown. */
export function limitResetTime(epochMs: number, timeZone = hostTimeZone()): string {
  try {
    return `${new Date(epochMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })} (${timeZone})`;
  } catch {
    return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/** A provider's HTTP error an engine posted as its whole reply instead of failing the turn (omp 18.12's ACP mode sends
 * it as message text and ends with end_turn): the status, an Anthropic `{"type":"error",…}` or OpenAI `{"error":{…}}`
 * body, and omp's ` retry-after-ms=<n>` when the provider named a wait. */
const ERROR_REPLY = /^([45]\d\d) (\{[\s\S]*\})(?: retry-after-ms=(\d+))?$/;

function isErrorBody(body: string): boolean {
  try {
    const value = JSON.parse(body);
    return value?.type === "error" || (typeof value?.error === "object" && value.error !== null);
  } catch {
    return false;
  }
}

export interface ErrorReplyFailure {
  message: string;
  stopReason: "quota" | "auth_required" | "rpc_error";
  setup?: true;
  limit?: "engine";
  limitResetsAt?: number;
}

/** A reply that is only a provider's error body, as the failed turn it is; null for any other text. It reads by its
 * words, as the same failure thrown would, and an account out of credits needs the person's setup. A 429 whose wait is
 * longer than an engine retries on its own is a usage limit too, and the wait names its reset. */
export function errorReplyFailure(provider: string, text: string, now = Date.now(), timeZone?: string): ErrorReplyFailure | null {
  const match = ERROR_REPLY.exec(text.trim());
  const body = match?.[2];
  if (!match || !body || !isErrorBody(body)) return null;
  const status = Number(match[1]);
  const waitMs = Number(match[3] ?? 0);
  const said = engineFailureKind(body, status);
  const kind = said !== "credits" && usageLimitWait(status, waitMs) ? "usage_limit" : said;
  const resetsAt = kind === "usage_limit" && waitMs > 0 ? now + waitMs : undefined;
  const message = engineFailureMessage(provider, body, { kind, status, resetsAt, timeZone })!;
  if (kind === "credits") return { message, stopReason: "auth_required", setup: true };
  if (kind !== "usage_limit") return { message, stopReason: "rpc_error" };
  return { message, stopReason: "quota", limit: "engine", ...(resetsAt ? { limitResetsAt: resetsAt } : {}) };
}

/** Only an out-of-credits failure or a refused tool schema or tool count in plain words; any other text stays as it is. */
export function plainFailureMessage(provider: string, text: string): string {
  const kind = engineFailureKind(text);
  return kind === "credits" || kind === "tool_schema" || kind === "tool_count" ? engineFailureMessage(provider, text, { kind })! : text;
}

/** ACP's StopReason values (protocol v1) that do say why a turn ended early, naming the AI when the caller knows it;
 * each carries the advice that fits it. */
const STOP_REASON_WORDS: Record<string, { words: (ai: string) => string; hint: string }> = {
  refusal: {
    words: (ai) => `${ai} refused to go on with this request`,
    hint: "Try again, reword the request, or switch this bot to another AI.",
  },
  max_tokens: {
    words: (ai) => `${ai}'s reply reached its maximum length before it finished`,
    hint: "Ask it to continue, or ask for a shorter answer.",
  },
  max_turn_requests: {
    words: () => "The turn made as many model requests as one turn may before it finished",
    hint: "Ask it to carry on from where it stopped, or split the task.",
  },
};

/** A failed turn's stop reason as its cause: a bare provider token ("stop_sequence", "rpc_error") is never the whole
 * message, and the token stays in it so its class still reads. */
export function stopCause(stopReason: string | null | undefined, provider?: string): string | undefined {
  const reason = stopReason?.trim();
  if (!reason) return undefined;
  const entry = Object.hasOwn(STOP_REASON_WORDS, reason) ? STOP_REASON_WORDS[reason] : undefined;
  if (entry) return `${entry.words(provider?.trim() || "The AI")} (stop reason: ${reason}). ${entry.hint}`;
  return /^[a-z][a-z0-9_]*$/i.test(reason) ? `The engine stopped without saying why (stop reason: ${reason}).` : reason;
}
