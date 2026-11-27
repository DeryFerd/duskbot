// Browser calls that failed in real use on the agent-browser engine, against a fake engine that answers as
// agent-browser 0.37.0 did in a headless Chrome.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserRuntime, type BrowserSpawnSpec } from "../browser-runtime.ts";

const ENGINE = `
const lines = require('node:readline').createInterface({ input: process.stdin });
const fs = require('node:fs');
const shown = new Set();
let clicks = 0;
const text = (value, isError) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: value }] });
lines.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'notifications/initialized') return;
  let result;
  if (m.method === 'tools/call') fs.appendFileSync(process.env.CALL_LOG, m.params.name + ' ' + JSON.stringify(m.params.arguments) + '\\n');
  const args = m.params && m.params.arguments || {};
  if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} } };
  else if (m.method === 'tools/list') result = { tools: [] };
  else if (m.params.name === 'agent_browser_eval') result = text(JSON.stringify(JSON.stringify({ url: 'http://fixture.test/', title: 'Fixture', text: 'clicks ' + clicks })));
  else if (m.params.name === 'agent_browser_wait_for_selector') {
    if (args.selector === '#late') { shown.add('#late'); result = text('{"success":true}'); }
    else result = text('Wait timed out after ' + args.waitTimeoutMs + 'ms', true);
  }
  else if (m.params.name === 'agent_browser_click' && args.selector === '@e9') result = text('Unknown ref: e9', true);
  else if (m.params.name === 'agent_browser_click' && args.selector === '@e2') result = text('Could not locate element with role=button name=Next', true);
  else if (m.params.name === 'agent_browser_click' && args.selector.startsWith('#') && !shown.has(args.selector)) result = text('Element not found: ' + args.selector + '. Verify the selector, role, or name is correct and the element exists in the DOM.', true);
  else if (m.params.name === 'agent_browser_click') { clicks += 1; result = text(JSON.stringify({ data: { clicked: args.selector }, error: null, success: true })); }
  else if (m.params.name === 'agent_browser_snapshot') result = text('- button "Ready" [ref=e1]\\n- link "Home" [ref=e2]');
  else result = text('about:blank');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`;

const runtimes: BrowserRuntime[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((value) => value.closeAll()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function engine(options: ConstructorParameters<typeof BrowserRuntime>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dusk-browser-failures-"));
  dirs.push(dir);
  const log = join(dir, "calls");
  const spec: BrowserSpawnSpec = { command: process.execPath, args: ["-e", ENGINE], env: { PATH: process.env.PATH, CALL_LOG: log } };
  const runtime = new BrowserRuntime({ requestTimeoutMs: 20_000, idleMs: 5_000, ...options });
  runtimes.push(runtime);
  const call = (name: string, args: Record<string, unknown> = {}) =>
    runtime.agentRpc("s", spec, "tools/call", { name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { call, calls };
}
const said = (result: { content: Array<{ text?: string }> }) => result.content.map((part) => part.text ?? "").join("\n");

describe("a plain wait", () => {
  it("is waited out by dusk bot while the browser is still getting ready, without reaching the engine", async () => {
    const launch = { ready: async () => { throw new Error("Getting the browser ready. Try again in a moment."); }, started: async () => {}, stopped: () => {} };
    const { call, calls } = engine({ launch });
    const started = Date.now();
    const waited = await call("agent_browser_wait_ms", { ms: "300" });
    expect(waited.isError).toBeUndefined();
    expect(JSON.parse(said(waited))).toEqual({ data: { ms: 300, waited: "timeout" }, error: null, success: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    await expect(call("agent_browser_get_url")).rejects.toThrow(/Getting the browser ready/);
    expect(calls()).toEqual([]);
  });

  it("says what it needs when no time is given", async () => {
    expect(await engine().call("agent_browser_wait_ms", {})).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('{"ms": 2000}') }] });
  });
});

describe("an element the page shows a moment later", () => {
  it("is waited for, then acted on, instead of failing as not found", async () => {
    const { call, calls } = engine();
    const clicked = await call("agent_browser_click", { selector: "#late" });
    expect(clicked.isError).toBeUndefined();
    expect(said(clicked)).toContain('"clicked":"#late"');
    expect(calls().filter((line) => !line.startsWith("agent_browser_eval"))).toEqual([
      'agent_browser_click {"selector":"#late"}',
      'agent_browser_wait_for_selector {"selector":"#late","waitTimeoutMs":5000}',
      'agent_browser_click {"selector":"#late"}',
    ]);
  });

  it("that never shows is reported plainly, with what to do next", async () => {
    const missing = await engine().call("agent_browser_click", { selector: "#never" });
    expect(missing.isError).toBe(true);
    expect(said(missing)).toBe("Element not found: nothing on the page matches #never, after waiting 5 s for it to show, so this call did nothing. Check the page with agent_browser_snapshot and act on a ref from it, or name the element by its text (text=Save).");
  });
});

describe("a ref from a snapshot the page moved on from", () => {
  it.each([["e9", "Unknown ref"], ["e2", "a ref whose element is gone"]])("%s (%s) answers with the page's fresh refs", async (ref) => {
    const { call } = engine();
    const stale = await call("agent_browser_click", { ref });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toBe(`${ref} is not on the page now: the page changed since the snapshot that ref came from, so this call did nothing. The page now, with fresh refs (earlier refs no longer apply):`);
    expect(stale.content[1]!.text).toContain('- button "Ready" [ref=e1]');
  });
});
