// The own-API-key chat engine against a fake provider on a real socket, one failure class each: a tool schema the
// provider rejects, a model without tool support, rate limits, a dropped connection. Each turn must end in a reply.
import { afterEach, describe, expect, it, vi } from "vitest";
process.env.FAKE_CHAT_RETRY_SCALE = "0.001";

import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { startFakeHttpMcp, type FakeHttpMcp, type FakeHttpMcpTool } from "../testing/fake-http-mcp-server.ts";
import { sseText, startFakeOpenAIProvider, type FakeOpenAIProvider, type FakeProviderReply, type FakeProviderRequest } from "../testing/fake-openai-provider.ts";

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const REMOTE = "https://api.example.test/v1";

/** Parameters with every keyword some provider refuses: a type list, const, a $ref, a free-form object, a uri format,
 * a number enum, exclusive bounds and additionalProperties. */
const RICH_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  $defs: { when: { type: "string", format: "date-time" } },
  properties: {
    url: { type: "string", format: "uri" },
    note: { type: ["string", "null"] },
    mode: { const: "fast" },
    level: { type: "integer", enum: [1, 2, 3] },
    count: { type: "number", exclusiveMinimum: 0 },
    at: { $ref: "#/$defs/when" },
    extra: { type: "object", additionalProperties: true },
    tags: { type: "array" },
  },
  required: ["url"],
};

/** Gemini's own words for a parameter keyword its Schema has no field for, found anywhere under `parameters`. */
function geminiRefusal(body: Record<string, any>): FakeProviderReply | null {
  const tools: any[] = body.tools ?? [];
  for (const [index, tool] of tools.entries()) {
    const text = JSON.stringify(tool.function.parameters);
    const bad = ["additionalProperties", "$schema", "$ref", "$defs", "const", "exclusiveMinimum"].find((key) => text.includes(`"${key}"`))
      ?? (/"type":\[/.test(text) ? "type" : /"format":"uri"/.test(text) ? "format" : /"enum":\[\d/.test(text) ? "enum" : undefined);
    if (bad) {
      return { status: 400, json: [{ error: { code: 400, status: "INVALID_ARGUMENT",
        message: `Invalid JSON payload received. Unknown name "${bad}" at 'tools[0].function_declarations[${index}].parameters': Cannot find field.` } }] };
    }
  }
  return null;
}

let provider: FakeOpenAIProvider | undefined, mcp: FakeHttpMcp | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await provider?.close(); provider = undefined;
  await mcp?.close(); mcp = undefined;
});

async function setup(url: string, model: string, reply: (request: FakeProviderRequest) => FakeProviderReply, tools: FakeHttpMcpTool[] = [{ name: "fetch_page", description: "Fetch a page", inputSchema: RICH_SCHEMA }]) {
  provider = await startFakeOpenAIProvider(reply);
  mcp = await startFakeHttpMcp({ tools });
  vi.stubGlobal("fetch", provider.routeFetch(new URL(url).origin));
  const instance = await OpenAICompatDriver.create({
    instanceId: "own-key", displayName: "My key", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url, apiKeyEnv: "K", model }),
    environment: { K: "fixture-key" },
  });
  const turn = async (extra: Partial<SendTurnInput> = {}) => {
    const events: RuntimeEvent[] = [];
    const off = instance.adapter.onEvent((event) => events.push(event));
    await instance.adapter.sendTurn({ threadId: `t${Math.random()}`, text: "Read example.com", approvalMode: "full",
      integrations: { custom: { web: { type: "http", url: mcp!.url, headers: {} } } }, ...extra });
    await vi.waitFor(() => expect(events.some((event) => event.type === "turn.completed")).toBe(true), { timeout: 20_000 });
    (off as unknown as (() => void) | undefined)?.();
    return {
      events,
      text: events.filter((event) => event.type === "item.completed" && (event as any).itemType === "assistant_text").map((event) => (event as any).text).join(""),
      errors: events.filter((event) => event.type === "runtime.error").map((event) => (event as any).message as string),
      notices: events.filter((event) => event.type === "runtime.notice").map((event) => (event as any).message as string),
    };
  };
  return { instance, turn };
}

const toolNames = (request: FakeProviderRequest) => (request.body.tools ?? []).map((tool: any) => tool.function.name);

describe("tool schemas a provider rejects", () => {
  it("sends Gemini its own schema dialect, so the first request is not refused", async () => {
    const { instance, turn } = await setup(GEMINI, "gemini-2.5-flash", ({ body }) => geminiRefusal(body) ?? { stream: sseText("Read it.") });
    try {
      const result = await turn();
      expect(result.errors).toEqual([]);
      expect(result.text).toBe("Read it.");
      expect(provider!.requests).toHaveLength(1);
      const sent = provider!.requests[0]!.body.tools.find((tool: any) => tool.function.name === "web_fetch_page").function.parameters;
      expect(sent.properties.url).toEqual({ type: "string" });
      expect(sent.properties.note).toEqual({ type: "string", nullable: true });
      expect(sent.properties.mode).toMatchObject({ type: "string", enum: ["fast"] });
      expect(sent.properties.level).toMatchObject({ type: "string", enum: ["1", "2", "3"] });
      expect(sent.properties.at).toEqual({ type: "string", format: "date-time" });
      expect(sent.properties.tags).toEqual({ type: "array", items: { type: "string" } });
      expect(sent.required).toEqual(["url"]);
    } finally { await instance.dispose(); }
  }, 30_000);

  it("resends in the strict dialect when another provider refuses a schema, then leaves out a tool it still refuses", async () => {
    const tools = [
      { name: "fetch_page", description: "Fetch a page", inputSchema: RICH_SCHEMA },
      { name: "odd", description: "A tool whose schema the provider never takes", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ];
    const { instance, turn } = await setup(REMOTE, "fixture-model", ({ body }) => {
      const names = (body.tools ?? []).map((tool: any) => tool.function.name);
      if (JSON.stringify(body.tools ?? []).includes("additionalProperties\":false")) {
        return { status: 400, json: { error: { message: "Invalid schema for function 'web_fetch_page': additionalProperties is not allowed", type: "invalid_request_error" } } };
      }
      if (names.includes("web_odd")) return { status: 400, json: { error: { message: "Invalid schema for function 'web_odd': schema is not supported", type: "invalid_request_error" } } };
      return { stream: sseText("Done without the odd tool.") };
    }, tools);
    try {
      const first = await turn();
      expect(first.errors).toEqual([]);
      expect(first.text).toBe("Done without the odd tool.");
      expect(toolNames(provider!.requests.at(-1)!)).toContain("web_fetch_page");
      expect(toolNames(provider!.requests.at(-1)!)).not.toContain("web_odd");
      const before = provider!.requests.length;
      expect((await turn()).errors).toEqual([]);
      // the next turn goes out in the form that worked
      expect(provider!.requests.length).toBe(before + 1);
    } finally { await instance.dispose(); }
  }, 30_000);
});

describe("models without tool support", () => {
  it.each([
    ["Ollama", 400, { error: { message: "registry.ollama.ai/library/gemma3:27b does not support tools" } }],
    ["OpenRouter", 404, { error: { message: "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing", code: 404 } }],
    ["Groq", 400, { error: { message: "tool calling is not supported with this model", type: "invalid_request_error" } }],
    ["vLLM", 400, { object: "error", message: "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set", type: "BadRequestError", code: 400 }],
  ])("answers without tools when %s says the model takes none, and says so once", async (_name, status, json) => {
    const { instance, turn } = await setup(REMOTE, "plain-model", ({ body }) => body.tools?.length ? { status, json } : { stream: sseText("Hello without tools.") });
    try {
      const first = await turn();
      expect(first.errors).toEqual([]);
      expect(first.text).toBe("Hello without tools.");
      expect(first.notices.some((notice) => notice.includes("can't use tools"))).toBe(true);
      // the model is told it has no tools, so it never answers as if it had looked
      const plain = provider!.requests.find((request) => !request.body.tools?.length)!;
      expect(plain.body.messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("this model can't use tools") });
      const before = provider!.requests.length;
      const second = await turn();
      expect(second.text).toBe("Hello without tools.");
      expect(provider!.requests.slice(before).every((request) => !request.body.tools?.length)).toBe(true);
    } finally { await instance.dispose(); }
  }, 30_000);
});

describe("rate limits and dropped connections", () => {
  it("waits out a per-minute rate limit with no Retry-After over more than two tries", async () => {
    const { instance, turn } = await setup(REMOTE, "fixture-model", ({ n }) => n <= 3
      ? { status: 429, json: { error: { message: "Rate limit reached for requests per minute", type: "requests", code: "rate_limit_exceeded" } } }
      : { stream: sseText("Here it is.") });
    try {
      const result = await turn();
      expect(result.errors).toEqual([]);
      expect(result.text).toBe("Here it is.");
      expect(provider!.requests).toHaveLength(4);
    } finally { await instance.dispose(); }
  }, 30_000);

  it("reads Gemini's RetryInfo delay when its words name no wait", async () => {
    const { instance, turn } = await setup(GEMINI, "gemini-2.5-flash", ({ n }) => n === 1
      ? { status: 429, json: [{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota).",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }] } }] }
      : { stream: sseText("Back with an answer.") });
    try {
      const result = await turn();
      expect(result.errors).toEqual([]);
      expect(result.text).toBe("Back with an answer.");
      const retrying = result.events.find((event) => event.type === "turn.retrying") as any;
      expect(retrying?.delayMs).toBeGreaterThanOrEqual(11_000);
    } finally { await instance.dispose(); }
  }, 30_000);

  it("tries a dropped connection more than twice before giving up", async () => {
    const { instance, turn } = await setup(REMOTE, "fixture-model", ({ n }) => n <= 3 ? { destroy: true } : { stream: sseText("Connected.") });
    try {
      const result = await turn();
      expect(result.errors).toEqual([]);
      expect(result.text).toBe("Connected.");
    } finally { await instance.dispose(); }
  }, 30_000);
});

describe("Gemini 3 thought signatures", () => {
  it("sends each tool call's thought signature back with it, as Gemini 3 requires", async () => {
    const signature = "sig-AbC123==";
    const call = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ id: "call_1", type: "function",
      function: { name: "web_fetch_page", arguments: JSON.stringify({ url: "https://example.com" }) }, extra_content: { google: { thought_signature: signature } } }] } }] })}\n\n`
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const { instance, turn } = await setup(GEMINI, "gemini-3.5-flash", ({ body, n }) => {
      if (n === 1) return { stream: [call] };
      const replayed = (body.messages as any[]).flatMap((message) => message.tool_calls ?? []);
      if (!replayed.length || replayed.some((entry) => entry.extra_content?.google?.thought_signature !== signature)) {
        return { status: 400, json: [{ error: { code: 400, status: "INVALID_ARGUMENT",
          message: "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance." } }] };
      }
      return { stream: sseText("Fetched it.") };
    });
    try {
      const result = await turn();
      expect(result.errors).toEqual([]);
      expect(result.text).toBe("Fetched it.");
      expect(mcp!.calls).toHaveLength(1);
    } finally { await instance.dispose(); }
  }, 30_000);

  it("never sends another provider the Gemini-only field", async () => {
    const call = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function",
      function: { name: "web_fetch_page", arguments: JSON.stringify({ url: "https://example.com" }) }, extra_content: { google: { thought_signature: "x" } } }] } }] })}\n\n`
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const { instance, turn } = await setup(REMOTE, "fixture-model", ({ body, n }) => n === 1 ? { stream: [call] }
      : JSON.stringify(body.messages).includes("extra_content") ? { status: 400, json: { error: { message: "Unrecognized field: extra_content" } } } : { stream: sseText("Fine.") });
    try {
      expect((await turn()).errors).toEqual([]);
    } finally { await instance.dispose(); }
  }, 30_000);
});

describe("Gemini's error envelope", () => {
  it("reads the message out of the one-element list Gemini's OpenAI-compatible endpoint wraps its errors in", async () => {
    const { instance, turn } = await setup(GEMINI, "gemini-2.5-flash", () => ({ status: 400, json: [{ error: { code: 400, status: "FAILED_PRECONDITION",
      message: "User location is not supported for the API use." } }] }));
    try {
      const { errors } = await turn();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("User location is not supported for the API use.");
      expect(errors[0]).not.toContain("[{");
    } finally { await instance.dispose(); }
  }, 30_000);
});
