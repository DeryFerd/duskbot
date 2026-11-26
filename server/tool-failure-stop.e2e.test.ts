import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlDusk } from "../scripts/control-dusk.ts";

const MCP_FIXTURE = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [
    { name: 'write_note', description: 'Save the disposable note', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } },
    { name: 'search_notes', description: 'Look up earlier notes', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  ] };
  else if (request.method === 'tools/call' && request.params.name === 'write_note') {
    writeFileSync(process.env.FIXTURE_ARTIFACT, request.params.arguments.content);
    result = { content: [{ type: 'text', text: 'saved' }] };
  } else result = { content: [{ type: 'text', text: 'search index is rebuilding' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

type ChatRequest = { messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }> };

// a turn whose note was saved and whose follow-up look-up failed: the reply is true, so no tool-failure stop card
it("a saved note with a failed look-up after it settles without the tool-failure stop", async () => {
  let scenario: "lookup" | "write" = "lookup";
  const turns: ChatRequest[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as ChatRequest;
    const frame = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const first = request.messages[0]?.content;
    if (typeof first === "string" && first.startsWith("You write one short chat message for")) { res.end(frame({ content: "SKIP" }, "stop") + "data: [DONE]\n\n"); return; }
    turns.push(request);
    const tool = (suffix: string) => request.tools?.find((entry) => entry.function.name.endsWith(suffix))?.function.name;
    const results = request.messages.filter((message) => message.role === "tool").length;
    const call = (id: string, name: string | undefined, args: unknown) => frame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    if (results === 0) res.end(call("save", tool("write_note"), { content: "dentist friday 3pm" }) + "data: [DONE]\n\n");
    else if (results === 1) res.end((scenario === "lookup" ? call("look", tool("search_notes"), { query: "dentist" }) : call("again", tool("write_note"), { content: 7 })) + "data: [DONE]\n\n");
    else res.end(frame({ content: "Saved your note: dentist Friday at 3pm." }, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture provider address missing");
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const control = (args: string[]) => runControlDusk([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" } });
    await api("POST", "/api/instances/openaiCompat/refresh-models", {});
    const script = join(fixture.info.dataDir, "notes-mcp.mjs");
    writeFileSync(script, MCP_FIXTURE);
    for (const starter of (await api("GET", "/api/bots")).bots) await api("PATCH", `/api/bots/${starter.id}`, { mcpServers: [] });
    const outcome: Record<string, unknown> = {};
    for (const mode of ["lookup", "write"] as const) {
      scenario = mode;
      const artifact = join(fixture.info.dataDir, `${mode}-note.txt`);
      for (const earlier of (await api("GET", "/api/bots")).bots) await api("PATCH", `/api/bots/${earlier.id}`, { mcpServers: [] });
      await api("POST", "/api/mcp/servers", { name: `notes${mode}`, command: process.execPath, args: [script], env: { FIXTURE_ARTIFACT: artifact }, enabled: true });
      await api("PATCH", `/api/mcp/servers/notes${mode}`, { enabled: true });
      const { bot } = await control(["new-bot", "--name", `Notes ${mode}`]);
      await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
      await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: [`notes${mode}`], approvalMode: "full" });
      expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Note that the dentist is Friday at 3pm."])).success).toBe(true);
      const settled = await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30"]);
      const messages = await control(["messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "20"]);
      const text = JSON.stringify(messages.messages);
      outcome[mode] = { status: settled.status, stopCard: text.includes("Stopped because the tool call") };
      expect(readFileSync(artifact, "utf8")).toBe("dentist friday 3pm");
    }
    console.info(JSON.stringify({ outcome, providerTurns: turns.length }));
    // the look-up failed after the save went through: settled, no stop card
    expect(outcome.lookup).toEqual({ status: "settled", stopCard: false });
    // a second save that failed is work the reply cannot prove: the stop card stays
    expect(outcome.write).toEqual({ status: "failed", stopCard: true });
  } finally {
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 180_000);
