#!/usr/bin/env node
// Fake of `hermes acp` model handling, after acp_adapter/session.py and server.py: session/new builds the
// agent on config.yaml's model (re-read every time), each session's model is saved to a state file that
// session/load restores (Hermes' state.db), and session/set_model only accepts models a provider can serve.
// A prompt on a model no provider serves fails like Hermes does when the model was removed. Env knobs:
//   HERMES_HOME  where config.yaml and fake-state.json live (default $HOME/.hermes)
//   FAKE_HERMES_SERVABLE  comma-separated `provider:model` ids a provider can still serve
//   FAKE_HERMES_SERVABLE_FILE  the same list, re-read per request, so a fixture can retire a model mid-run
//   FAKE_HERMES_LOG  one JSON line per request ({pid, method, params}) appended here
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

if (process.argv.includes("--version")) {
  process.stderr.write("Hermes Agent v0.99.0 (fake)\n");
  process.exit(0);
}

const home = process.env.HERMES_HOME || join(process.env.HOME || ".", ".hermes");
mkdirSync(home, { recursive: true });
const statePath = join(home, "fake-state.json");
const servableList = (text: string) => text.split(",").map((id) => id.trim()).filter(Boolean);
const servableFixed = servableList(process.env.FAKE_HERMES_SERVABLE ?? "");
function servableNow(): Set<string> {
  const file = process.env.FAKE_HERMES_SERVABLE_FILE;
  if (!file) return new Set(servableFixed);
  try {
    return new Set(servableList(readFileSync(file, "utf8")));
  } catch {
    return new Set();
  }
}

type Route = { provider: string; model: string };
const live = new Map<string, Route>();

function configRoute(): Route {
  try {
    const config = parseYaml(readFileSync(join(home, "config.yaml"), "utf8")) as any;
    const model = config?.model;
    if (typeof model === "string") return { provider: "openrouter", model };
    return { provider: String(model?.provider || "openrouter").toLowerCase(), model: String(model?.default || "") };
  } catch {
    return { provider: "openrouter", model: "" };
  }
}

function readState(): Record<string, Route> {
  try {
    return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  } catch {
    return {};
  }
}

function save(sessionId: string, route: Route) {
  live.set(sessionId, route);
  writeFileSync(statePath, JSON.stringify({ ...readState(), [sessionId]: route }));
}

const encode = (route: Route) => `${route.provider}:${route.model}`;
const modelState = (route: Route) => ({
  availableModels: [...new Set([encode(route), ...servableNow()])].map((modelId) => ({ modelId, name: modelId.split(":").slice(1).join(":") })),
  currentModelId: encode(route),
});

function parse(raw: string, current: Route): Route {
  const colon = raw.indexOf(":");
  return colon > 0 ? { provider: raw.slice(0, colon).toLowerCase(), model: raw.slice(colon + 1) } : { provider: current.provider, model: raw };
}

const out = (msg: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...(msg as object) })}\n`);
let sessions = 0;

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (process.env.FAKE_HERMES_LOG && msg.method) {
      appendFileSync(process.env.FAKE_HERMES_LOG, `${JSON.stringify({ pid: process.pid, method: msg.method, params: msg.params })}\n`);
    }
    handle(msg);
  }
});

function handle(msg: any) {
  const sessionId = msg.params?.sessionId;
  switch (msg.method) {
    case "initialize":
      return out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {} }, authMethods: [] } });
    case "session/new": {
      const id = `hermes-${process.pid}-${++sessions}`;
      const route = configRoute();
      save(id, route);
      return out({ id: msg.id, result: { sessionId: id, models: modelState(route) } });
    }
    case "session/load": {
      const route = live.get(sessionId) ?? readState()[sessionId];
      if (!route) return out({ id: msg.id, result: null });
      live.set(sessionId, route);
      return out({ id: msg.id, result: { models: modelState(route) } });
    }
    case "session/set_model": {
      const current = live.get(sessionId);
      if (!current) return out({ id: msg.id, result: null });
      const next = parse(String(msg.params?.modelId ?? ""), current);
      if (!servableNow().has(encode(next))) {
        return out({ id: msg.id, error: { code: -32602, message: "Invalid params", data: { details: `Model '${next.model}' was not found on ${next.provider}` } } });
      }
      save(sessionId, next);
      return out({ id: msg.id, result: {} });
    }
    case "session/set_mode":
      return out({ id: msg.id, result: {} });
    case "session/prompt": {
      const route = live.get(sessionId);
      if (!route || !servableNow().has(encode(route))) {
        return out({ id: msg.id, error: { code: -32603, message: `HTTP 404: model '${route?.model ?? "?"}' not found` } });
      }
      out({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ran on ${encode(route)}` } } } });
      return out({ id: msg.id, result: { stopReason: "end_turn" } });
    }
    case "session/cancel":
      return;
    default:
      if (msg.id !== undefined) out({ id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}
