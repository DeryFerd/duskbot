// The one short line a trace shows beside a tool: the query, the page, the action. Typed text, messages and file bodies are
// never kept, and every line passes the secret redaction before it is stored.
import { redactSecretsInText } from "../../shared/redact.ts";
import { TOOL_NAMESPACE } from "../../shared/tool-surface.ts";

export const DETAIL_MAX = 80;
export const ERROR_MAX = 120;

const clip = (text: string, max: number): string | undefined => {
  const flat = redactSecretsInText(text.replace(/\s+/g, " ").trim());
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function fieldsOf(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== "string" || !/^\s*\{/.test(input)) return null;
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pageOf(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host.replace(/^www\./, "")}${path}`;
  } catch {
    return undefined;
  }
}

const QUERY_KEYS = ["query", "q", "search", "search_query", "pattern", "searchTerm"];
const PAGE_KEYS = ["url", "uri", "href", "link"];
const FILE_KEYS = ["file_path", "filePath", "path", "notebook_path", "file"];
const ACTION_KEYS = ["action", "operation", "method", "kind"];

/** A tool's detail from its call: a shell summary, a parsed preview, or nothing. Never the raw arguments. */
export function toolDetail(name: string, input: unknown, summary?: string): string | undefined {
  if (summary) return clip(summary, DETAIL_MAX);
  const fields = fieldsOf(input);
  if (!fields) return undefined;
  const text = (key: string) => typeof fields[key] === "string" ? (fields[key] as string) : undefined;
  for (const key of QUERY_KEYS) if (text(key)) return clip(text(key)!, DETAIL_MAX);
  for (const key of PAGE_KEYS) {
    const page = text(key) && pageOf(text(key)!);
    if (page) return clip(page, DETAIL_MAX);
  }
  for (const key of FILE_KEYS) {
    const path = text(key);
    if (path) return clip(path.split(/[\\/]/).filter(Boolean).slice(-2).join("/"), DETAIL_MAX);
  }
  if (text("command")) return clip(text("command")!, DETAIL_MAX);
  const bare = name.replace(TOOL_NAMESPACE, "");
  for (const key of ACTION_KEYS) if (text(key)) return clip(text(key)!.replace(/[_-]+/g, " "), DETAIL_MAX);
  if (typeof fields.name === "string" && /^(?:use_tool|call_tool)$/.test(bare)) return clip(fields.name, DETAIL_MAX);
  if (Array.isArray(fields.coordinate) && fields.coordinate.length === 2) return clip(`at ${fields.coordinate.join(", ")}`, DETAIL_MAX);
  return undefined;
}

/** A page title a browser tool reported, when its output states one. */
export function pageTitle(output: unknown): string | undefined {
  if (typeof output !== "string") return undefined;
  const match = /(?:^|\n|"|\b)(?:page )?title["']?\s*[:=]\s*["']?([^"'\n]{1,120})/i.exec(output);
  return match ? clip(match[1]!, 60) : undefined;
}

export function errorLine(output: unknown): string | undefined {
  if (typeof output !== "string") return undefined;
  const first = output.split("\n").find((line) => line.trim());
  return first ? clip(first, ERROR_MAX) : undefined;
}

const TEXT_KEYS = ["error", "message", "text", "stderr", "output", "content", "result", "detail", "reason"];
const PREVIEW_CUT = /\n\[… preview shortened\]$/;
const QUOTED_TEXT = /"(?:error|message|text|stderr|output)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const EXIT_LINE = /^(?:error:\s*)?exit code (-?\d+|unknown)\b/i;
const MARKER_LINE = /^(?:-{2,}\s*(?:stdout|stderr)\s*-{2,}|\(no output\))$/i;

/** the words inside a parsed preview: a content block list's text, an error's message, a command's exit code and output */
function textOf(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => textOf(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  const fields = value as Record<string, unknown>;
  const exit = fields.exitCode ?? fields.exit_code;
  const said = TEXT_KEYS.map((key) => textOf(fields[key], depth + 1)).find((text) => text.trim()) ?? "";
  return typeof exit === "number" && exit !== 0 ? `Exit code ${exit}\n${said}` : said;
}

function previewText(output: string): string {
  if (!/^\s*[[{]/.test(output)) return output;
  try {
    return textOf(JSON.parse(output.replace(PREVIEW_CUT, "")));
  } catch {
    const quoted = QUOTED_TEXT.exec(output)?.[1];
    if (!quoted) return output;
    try { return JSON.parse(`"${quoted}"`) as string; } catch { return quoted; }
  }
}

/** A failed tool call's one error line, read from its output as an engine previews it: the text inside a JSON preview
 * (an MCP result's content, a command's output and exit code) rather than its opening brace, and an "Exit code N"
 * line joined to the first thing the command printed (its stderr when it printed one). */
export function toolErrorLine(output: unknown): string | undefined {
  if (typeof output !== "string") return undefined;
  const lines = previewText(output).split("\n").map((line) => line.trim()).filter(Boolean);
  const first = lines[0];
  if (!first) return undefined;
  if (!EXIT_LINE.test(first)) return clip(first, ERROR_MAX);
  const stderr = lines.indexOf("--- stderr ---");
  const said = (stderr >= 0 ? lines.slice(stderr + 1) : lines.slice(1)).find((line) => !MARKER_LINE.test(line));
  return clip(said ? `${first}: ${said}` : first, ERROR_MAX);
}
