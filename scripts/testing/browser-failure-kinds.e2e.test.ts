// The browser failures models met on the agent-browser engine, through the real harness, a scripted fake engine turn
// and a real headless Chrome. Opt-in like local-browser.e2e.test.ts. DUSK_PROBE_STEPS runs a file of [tool, arguments]
// steps instead and writes each answer to DUSK_PROBE_OUT, with no expectations.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlDusk, type VerificationServer } from "../control-dusk.ts";

const binaryPath = process.env.DUSK_VERIFY_BROWSER_BINARY;
const executablePath = process.env.DUSK_VERIFY_BROWSER_CHROME;
const stepsFile = process.env.DUSK_PROBE_STEPS;

// each step's answer as the bot reads it: ok or not, and a pattern its text must match
const EXPECTED: Array<[string, Record<string, unknown>, boolean, RegExp]> = [
  ["agent_browser_wait_ms", { ms: 300 }, true, /"waited":"timeout"/],
  ["agent_browser_open", { url: "ORIGIN/alert" }, true, /button "Confirm"/],
  ["agent_browser_click", { selector: "#c" }, true, /answered Cancel.*"dialog": "accept"/],
  ["agent_browser_get_title", {}, true, /^false$/],
  ["agent_browser_click", { selector: "#c", dialog: "accept" }, true, /answered OK, as this call asked/],
  ["agent_browser_get_title", {}, true, /^true$/],
  ["agent_browser_open", { url: "ORIGIN/form" }, true, /textbox "Name"/],
  ["agent_browser_eval", { script: "return document.title" }, true, /^"Form"$/],
  ["agent_browser_eval", { script: "await new Promise(r => setTimeout(r, 50)); document.title" }, true, /^"Form"$/],
  ["agent_browser_eval", { script: "() => document.querySelectorAll('a').length" }, true, /^1$/],
  ["agent_browser_click", { selector: "@e99" }, false, /^e99 is not on the page now.*fresh refs[\s\S]*button "Say hello" \[ref=e\d+\]/],
  ["agent_browser_open", { url: "ORIGIN/late" }, true, /Late/],
  ["agent_browser_click", { selector: "#late" }, true, /Text that appeared on the page: "Ready"/],
  ["agent_browser_click", { selector: "#never" }, false, /after waiting 5 s for it to show/],
  ["agent_browser_batch", { steps: [{ do: "navigate", url: "ORIGIN/form" }, { action: "fill", selector: "#name", text: "x" }, { do: "click", selector: "#greet" }, { do: "wait", ms: 100 }, { do: "get_text", selector: "#result" }] }, true, /Ran all 5 steps[\s\S]*Hello, x/],
];

const PAGES: Record<string, string> = {
  "/form": `<!doctype html><title>Form</title><label>Name <input id="name"></label>
    <button id="greet" onclick="document.getElementById('result').textContent='Hello, '+document.getElementById('name').value">Say hello</button>
    <p id="result">Not submitted</p><a href="/late">Later page</a>`,
  "/dup": `<!doctype html><title>Dup</title><button>Go</button><button>Go</button><div class="item">a</div><div class="item">b</div>`,
  "/late": `<!doctype html><title>Late</title><p>Loading</p><script>setTimeout(()=>{const b=document.createElement('button');b.id='late';b.textContent='Ready';document.body.append(b)},1500)</script>`,
  "/blank": `<!doctype html><title>Blank</title>`,
  "/alert": `<!doctype html><title>Alert</title><button id="a" onclick="alert('hi');document.title='after'">Alert</button><button id="c" onclick="document.title=confirm('sure?')">Confirm</button>`,
  "/unload": `<!doctype html><title>Unload</title><input id="t"><script>addEventListener('beforeunload',e=>{e.preventDefault();e.returnValue=''})</script>`,
  "/nav": `<!doctype html><title>Nav</title><button id="go" onclick="location.href='/form'">Next</button>`,
};

it.skipIf(!binaryPath || !executablePath)("answers the browser calls that failed in real use, or says plainly what to do instead", async () => {
  const page = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/slow") { setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Slow</title>slow"); }, 25_000); return; }
    if (path === "/hang") return;
    if (path === "/missing") { res.writeHead(404, { "content-type": "text/html" }); res.end("<title>Not found</title><h1>404 Not Found</h1>"); return; }
    if (path === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF-1.1\n%%EOF"); return; }
    if (path === "/json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }
    res.writeHead(PAGES[path] ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGES[path] ?? "<title>none</title>none");
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
  let fixture: VerificationServer;
  try {
    fixture = await launchVerificationServer({ DUSK_TEST_LOCAL_BROWSER_GUARD: "1" }, undefined, undefined,
      { binaryPath: binaryPath!, executablePath: executablePath! }, { scripted: true });
  } catch (error) { await new Promise<void>((resolve) => page.close(() => resolve())); throw error; }
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    return await response.json() as any;
  };
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  try {
    await api("PATCH", "/api/config", { features: { browser: true }, browserEngine: { engine: "agent-browser", egress: { allow: ["127.0.0.1"] } } });
    const bot = (await api("POST", "/api/bots", { name: "Probe" })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: true, browserProfile: process.env.DUSK_PROBE_PROFILE ?? "guest", approvalMode: "full" });
    const listed: Array<[string, Record<string, unknown>]> = stepsFile ? JSON.parse(readFileSync(stepsFile, "utf8")) : EXPECTED;
    const steps = JSON.parse(JSON.stringify(listed).replaceAll("ORIGIN", origin)).map((s: [string, unknown]) => ({ server: "browser", tool: s[0], arguments: s[1] ?? {}, anyOutcome: true }));
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [{ timeoutMs: 290_000, steps, reply: "PROBED" }] } }));
    await runControlDusk(["send", "--bot", bot.id, "--text", "probe", "--url", fixture.info.url]);
    let turn: any;
    await expect.poll(() => {
      try { turn = JSON.parse(readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n")[0]!); return Boolean(turn); }
      catch { return false; }
    }, { timeout: Number(process.env.DUSK_PROBE_WAIT_MS ?? 290_000), interval: 200 }).toBe(true);
    const lines = turn.evidence.filter((entry: any) => entry.step?.server === "browser").map((entry: any) => {
      const r = entry.response?.result; const text = (r?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" | ");
      return `${r?.isError ? "ERR" : entry.response?.error ? "RPC" : "ok "} ${entry.step.tool} ${JSON.stringify(entry.step.arguments).replace(origin, "")}\n    ${(entry.response?.error ? JSON.stringify(entry.response.error) : text).slice(0, 700).replaceAll("\n", "\\n")}`;
    });
    writeFileSync(process.env.DUSK_PROBE_OUT ?? `${fixture.info.logPath}.probe.txt`, lines.join("\n") + "\n");
    if (!stepsFile) {
      const answers = turn.evidence.filter((entry: any) => entry.step?.server === "browser").map((entry: any) => entry.response?.result);
      expect(answers).toHaveLength(EXPECTED.length);
      EXPECTED.forEach(([tool, , ok, pattern], i) => {
        const text = (answers[i]?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" | ");
        expect(answers[i]?.isError === true, `${i + 1}. ${tool}: ${text}`).toBe(!ok);
        expect(text, `${i + 1}. ${tool}`).toMatch(pattern);
      });
    }
  } finally {
    if (process.env.DUSK_PROBE_LOG) writeFileSync(process.env.DUSK_PROBE_LOG, readFileSync(fixture.info.logPath, "utf8"));
    await promisify(execFile)(binaryPath!, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir,
      TMPDIR: join(fixture.info.dataDir, "tmp"), PATH: process.env.PATH }, timeout: 15_000 }).catch(() => {});
    await fixture.close();
    await new Promise<void>((resolve) => page.close(() => resolve()));
  }
}, 330_000);
