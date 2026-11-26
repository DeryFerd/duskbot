// The tool list one chat-completions request carries. The model reads these schemas; the server still checks every call
// against the tool's full schema, so a provider's narrower schema dialect only loses hints, never validation.
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** Google's OpenAI-compatible endpoints (Gemini API, Vertex AI) turn function parameters into Gemini's OpenAPI 3.0
 * `Schema` and refuse the whole request with HTTP 400 on any keyword that has no field there ("Invalid JSON payload
 * received. Unknown name \"additionalProperties\" at 'tools[0].function_declarations[2].parameters'"), on a type list,
 * on an enum that is not of strings and on a string `format` other than enum or date-time. */
export function wantsStrictToolSchemas(url: string, model: string): boolean {
  const host = hostOf(url);
  if (host === "generativelanguage.googleapis.com" || host.endsWith("aiplatform.googleapis.com")) return true;
  return host !== "openrouter.ai" && /^(?:models\/|google\/)?gemini-/i.test(model);
}

/** Keywords Gemini's Schema has a field for; anything else is left out. */
const KEPT = new Set(["type", "format", "title", "description", "nullable", "enum", "maxItems", "minItems", "properties", "required",
  "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "default", "anyOf", "propertyOrdering", "items",
  "minimum", "maximum"]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array"]);
const STRING_FORMATS = new Set(["enum", "date-time"]);
const NUMBER_FORMATS = new Set(["float", "double", "int32", "int64"]);
const MAX_DEPTH = 24;

function pointer(root: Json, ref: string): unknown {
  if (!ref.startsWith("#/")) return ref === "#" ? root : undefined;
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

const valueType = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;

/** One subschema in Gemini's dialect: local refs inlined (a cycle or a ref too deep becomes a free string), `const` an
 * enum, a type list one type plus `nullable`, `oneOf`/`allOf` read as `anyOf`, exclusive bounds as inclusive ones. */
function strict(node: unknown, root: Json, depth: number, refs: ReadonlySet<string>): Json {
  if (!isObject(node) || depth > MAX_DEPTH) return { type: "string" };
  if (typeof node.$ref === "string") {
    const target = refs.has(node.$ref) ? undefined : pointer(root, node.$ref);
    if (!isObject(target)) return { type: "string", ...(typeof node.description === "string" ? { description: node.description } : {}) };
    const { $ref: _ref, ...siblings } = node;
    return strict({ ...target, ...siblings }, root, depth, new Set([...refs, node.$ref]));
  }
  const source: Json = { ...node };
  if ("const" in source && !("enum" in source)) source.enum = [source.const];
  if (typeof source.exclusiveMinimum === "number" && source.minimum === undefined) source.minimum = source.exclusiveMinimum;
  if (typeof source.exclusiveMaximum === "number" && source.maximum === undefined) source.maximum = source.exclusiveMaximum;
  const alternatives = [source.anyOf, source.oneOf].flatMap((list) => (Array.isArray(list) ? list : []));
  const merged = Array.isArray(source.allOf) ? source.allOf.filter(isObject) : [];
  for (const part of merged) {
    if (isObject(part.properties)) source.properties = { ...part.properties, ...(isObject(source.properties) ? source.properties : {}) };
    if (Array.isArray(part.required)) source.required = [...new Set([...(Array.isArray(source.required) ? source.required : []), ...part.required])];
    if (source.type === undefined && part.type !== undefined) source.type = part.type;
  }

  const out: Json = {};
  const listed = Array.isArray(source.type) ? source.type.filter((type): type is string => typeof type === "string") : typeof source.type === "string" ? [source.type] : [];
  const real = listed.filter((type) => TYPES.has(type));
  let type: string | undefined = real[0];
  if (listed.includes("null")) out.nullable = true;
  if (!type && !alternatives.length) {
    type = isObject(source.properties) ? "object" : "items" in source ? "array"
      : Array.isArray(source.enum) && source.enum.length ? valueType(source.enum.find((value) => value !== null)) : undefined;
    if (type && !TYPES.has(type)) type = undefined;
  }

  const nonNull = alternatives.filter((branch) => !(isObject(branch) && branch.type === "null"));
  if (nonNull.length < alternatives.length) out.nullable = true;
  if (nonNull.length === 1 && !type) return { ...strict({ ...source, anyOf: undefined, oneOf: undefined, ...(nonNull[0] as Json) }, root, depth, refs), ...(out.nullable ? { nullable: true } : {}) };
  if (nonNull.length > 0 && !type) out.anyOf = nonNull.map((branch) => strict(branch, root, depth + 1, refs));
  if (type) out.type = type;

  for (const key of ["title", "description", "minItems", "maxItems", "minProperties", "maxProperties", "minLength", "maxLength", "minimum", "maximum"]) {
    if (KEPT.has(key) && source[key] !== undefined && (typeof source[key] === "string" || typeof source[key] === "number")) out[key] = source[key];
  }
  if (typeof source.pattern === "string" && type === "string") out.pattern = source.pattern;
  if (typeof source.format === "string" && ((type === "string" && STRING_FORMATS.has(source.format)) || ((type === "number" || type === "integer") && NUMBER_FORMATS.has(source.format)))) out.format = source.format;
  if (Array.isArray(source.enum)) {
    const values = source.enum.filter((value) => value !== null && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")).map(String);
    if (values.length) {
      // Gemini takes an enum only on a string
      const choices = [...new Set(values)];
      out.type = "string";
      out.enum = choices;
      if (type !== "string") out.description = `${typeof out.description === "string" ? `${out.description} ` : ""}(one of ${choices.join(", ")}, as ${type ?? "its"} value)`.trim();
      delete out.minimum; delete out.maximum; delete out.format;
    }
  }
  if (out.type === "object" || (!out.type && isObject(source.properties))) {
    const properties = isObject(source.properties) ? source.properties : {};
    const kept: Json = {};
    for (const [key, child] of Object.entries(properties)) kept[key] = strict(child, root, depth + 1, refs);
    if (Object.keys(kept).length) {
      out.properties = kept;
      const required = Array.isArray(source.required) ? source.required.filter((key): key is string => typeof key === "string" && Object.hasOwn(kept, key)) : [];
      if (required.length) out.required = [...new Set(required)];
    } else if (depth > 0) {
      // a free-form object nested in a tool reads as no fields at all; say what goes there instead
      out.description = `${typeof out.description === "string" ? `${out.description} ` : ""}(an object with any fields)`.trim();
    }
  }
  if (out.type === "array") out.items = isObject(source.items) ? strict(source.items, root, depth + 1, refs) : Array.isArray(source.prefixItems) && isObject(source.prefixItems[0]) ? strict(source.prefixItems[0], root, depth + 1, refs) : { type: "string" };
  return out;
}

/** A tool's parameters in Gemini's dialect; the root is always an object. */
export function strictToolParameters(parameters: unknown): Json {
  const root = isObject(parameters) ? parameters : {};
  const fitted = strict({ ...root, type: "object" }, root, 0, new Set());
  return { ...fitted, type: "object", properties: isObject(fitted.properties) ? fitted.properties : {} };
}

const strictCache = new WeakMap<ChatToolDefinition, ChatToolDefinition>();

function strictDefinition(definition: ChatToolDefinition): ChatToolDefinition {
  let fitted = strictCache.get(definition);
  if (!fitted) {
    fitted = { ...definition, function: { ...definition.function, parameters: strictToolParameters(definition.function.parameters) } };
    strictCache.set(definition, fitted);
  }
  return fitted;
}

/** How one model takes tools, learned from the provider's refusals; kept for the runtime's life. */
export interface ToolWire {
  /** Sent no tools: the provider said this model can't take them. */
  none: boolean;
  /** Sent schemas in Gemini's narrower dialect. */
  strict: boolean;
  /** Tools the provider refused by name, left out. */
  dropped: Set<string>;
}

export function toolsOnWire(definitions: readonly ChatToolDefinition[], wire: ToolWire): ChatToolDefinition[] {
  if (wire.none) return [];
  const kept = wire.dropped.size ? definitions.filter((definition) => !wire.dropped.has(definition.function.name)) : [...definitions];
  return wire.strict ? kept.map(strictDefinition) : kept;
}

/** A provider's refusal of the tools' schemas, not of the conversation: Gemini's `function_declarations[N]`, OpenAI's
 * "Invalid schema for function 'x'", Anthropic-style `tools.N.custom.input_schema`, Bedrock's `toolSpec.inputSchema`,
 * Moonshot's flavoured schema, and the generic "tools[N]... schema" wording of vLLM, Mistral, xAI and Groq. */
const SCHEMA_REFUSAL = /function_declarations\[\d+\]|invalid schema for function\b|\btools\.\d+\.custom\.input_schema\b|\btoolSpec\.inputSchema\b|moonshot flavou?red json schema|\btools\[\d+\][\w.[\]]*\b.*\b(?:schema|parameters)\b|\b(?:json[_ ]?schema|parameters? schema|function parameters?)\b.*\b(?:invalid|not (?:supported|allowed|valid)|unsupported|unknown)\b|\b(?:invalid|unsupported)\b.*\b(?:json[_ ]?schema|tool schema|function parameters?)\b/i;

export function refusesToolSchema(status: number, text: string): boolean {
  return (status === 400 || status === 422) && SCHEMA_REFUSAL.test(text);
}

/** The tool a schema refusal names: by name ("function 'x'"), or by its place in the list that was sent. */
export function refusedToolName(text: string, sent: readonly ChatToolDefinition[]): string | undefined {
  const named = /\b(?:function|tool)s?\s*['"`]([\w.:-]{1,128})['"`]/i.exec(text)?.[1];
  if (named && sent.some((definition) => definition.function.name === named)) return named;
  // Gemini sends every declaration in tools[0], so its declaration index is the place
  const index = /function_declarations\[(\d+)\]/i.exec(text) ?? /\btools\[(\d+)\]|\btools\.(\d+)\./i.exec(text);
  const at = index ? Number(index[1] ?? index[2]) : NaN;
  return Number.isInteger(at) ? sent[at]?.function.name : undefined;
}

/** Tool support some providers report in words: Ollama's "does not support tools", Groq's and DeepInfra's "is not
 * supported", Mistral's "not enabled for this model", OpenRouter's 404 "No endpoints found that support tool use",
 * vLLM started without `--enable-auto-tool-choice`, llama.cpp started without `--jinja`. */
const NO_TOOLS = /\bdoes not support (?:tools|tool[ _]?(?:use|calling|calls)|function[ _]?calling)\b|\b(?:tools|tool[ _]?(?:use|calling|calls)|function[ _]?calling) (?:is|are) not (?:supported|enabled|available)\b|no endpoints found that support tool use|enable-auto-tool-choice|tools param requires --jinja|\bdoes not support function\b/i;

export function refusesToolsInWords(status: number, text: string): boolean {
  return (status === 400 || status === 404 || status === 422) && NO_TOOLS.test(text) && !/\b(?:api[ _-]?key|unauthori[sz]ed|authenticat)/i.test(text);
}

export const answeredWithoutTools = (model: string): string =>
  `${model} can't use tools, so it answered without them. Pick a model that can use tools for steps like browsing or files.`;

/** The provider refused the tools' schemas; `tool` is the one it named, when it named one that was sent. */
export class ToolSchemaRefusedError extends Error {
  readonly tool: string | undefined;
  constructor(message: string, tool: string | undefined) {
    super(message);
    this.tool = tool;
  }
}
