import { describe, expect, it } from "vitest";
import { refusedToolName, refusesToolSchema, refusesToolsInWords, strictToolParameters, wantsStrictToolSchemas } from "./chat-tool-wire.ts";

const tool = (name: string) => ({ type: "function" as const, function: { name, description: "", parameters: { type: "object", properties: {} } } });

describe("strictToolParameters", () => {
  it("ends a cyclic $ref as a plain string and keeps the rest", () => {
    const schema = { type: "object", $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" }, name: { type: "string" } } } },
      properties: { root: { $ref: "#/$defs/node" } } };
    expect(strictToolParameters(schema)).toEqual({ type: "object", properties: { root: { type: "object",
      properties: { child: { type: "string" }, name: { type: "string" } } } } });
  });
  it("reads an anyOf with null as a nullable value, and a free-form root as an object with no fields", () => {
    expect(strictToolParameters({ properties: { at: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] } } }))
      .toEqual({ type: "object", properties: { at: { type: "integer", minimum: 0, nullable: true } } });
    expect(strictToolParameters({ type: "object", additionalProperties: true })).toEqual({ type: "object", properties: {} });
  });
  it("is used for Google's endpoints and Gemini models outside OpenRouter", () => {
    expect(wantsStrictToolSchemas("https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash")).toBe(true);
    expect(wantsStrictToolSchemas("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/endpoints/openapi", "google/gemini-2.5-pro")).toBe(true);
    expect(wantsStrictToolSchemas("https://litellm.example.test/v1", "gemini-3.5-flash")).toBe(true);
    expect(wantsStrictToolSchemas("https://openrouter.ai/api/v1", "google/gemini-2.5-flash")).toBe(false);
    expect(wantsStrictToolSchemas("https://api.groq.com/openai/v1", "llama-3.3-70b-versatile")).toBe(false);
  });
});

describe("provider refusals", () => {
  it("names the tool a schema refusal points at, by name or by place", () => {
    const sent = [tool("a"), tool("b"), tool("c")];
    expect(refusedToolName("Invalid schema for function 'b': x", sent)).toBe("b");
    expect(refusedToolName("Unknown name \"const\" at 'tools[0].function_declarations[2].parameters'", sent)).toBe("c");
    expect(refusedToolName("Invalid schema for function 'zzz'", sent)).toBeUndefined();
  });
  it("tells a schema refusal and a model without tools from other 400s", () => {
    expect(refusesToolSchema(400, "Unknown name \"additionalProperties\" at 'tools[0].function_declarations[1].parameters'")).toBe(true);
    expect(refusesToolSchema(400, "Invalid request body.")).toBe(false);
    expect(refusesToolSchema(429, "Invalid schema for function 'a'")).toBe(false);
    expect(refusesToolsInWords(400, "model does not support tools")).toBe(true);
    expect(refusesToolsInWords(400, "Invalid API key; tools are not supported.")).toBe(false);
    expect(refusesToolsInWords(500, "This model does not support tools.")).toBe(false);
  });
});
