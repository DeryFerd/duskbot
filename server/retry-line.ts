import { RETRY_MAX_ATTEMPTS } from "./drivers/retry.ts";
import { serverLine, type ServerLineKey } from "./server-lines.ts";

const WHY: Readonly<Record<string, ServerLineKey>> = {
  rate_limited: "server.retry.why.rateLimited",
  overloaded: "server.retry.why.overloaded",
  server_error: "server.retry.why.serverError",
  connection_reset: "server.retry.why.connection",
  timeout: "server.retry.why.timeout",
  request_too_large: "server.retry.why.tooLarge",
  tool_use_failed: "server.retry.why.toolCall",
  auth: "server.retry.why.signIn",
};

/** The row a driver's `turn.retrying` leaves in the chat, in plain words: the engine's reason code never shows. */
export function retryLine(language: string | undefined, event: { attempt: number; delayMs: number; reason: string; maxAttempts?: number }): string {
  const attempt = event.attempt + 1;
  const seconds = Math.round(event.delayMs / 1000);
  const why = serverLine(language, Object.hasOwn(WHY, event.reason) ? WHY[event.reason]! : "server.retry.why.other");
  const params = { attempt, max: Math.max(event.maxAttempts ?? RETRY_MAX_ATTEMPTS, attempt), why };
  return seconds > 0 ? serverLine(language, "server.retry.in", { ...params, seconds }) : serverLine(language, "server.retry.now", params);
}
