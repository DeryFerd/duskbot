// the provider paused a customer's machine (InstaBox, 2026-11-27: every cloud, for an unpaid workspace): nobody reads its own
// page, the home reads as waking while the account service resumes it, and the operator hears once per incident
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type EdgeEnv } from "../edge/worker.js";
import { homeFixture } from "./test-fixture.ts";

const TOKEN = "e".repeat(40), DOMAIN = "desktops.example.com", ROUTE_URL = "https://dash.example.test";
const PAGE = "Sandbox offline: it is paused, and only a sandbox that paused itself for being idle wakes on a visit. Its owner can resume it: instabox resume sbx_1";
afterEach(() => vi.unstubAllGlobals());

async function edged() {
  const f = await homeFixture({ settings: { publicDomain: DOMAIN, edgeWakesPerHour: 20 }, edgeToken: TOKEN });
  const { c } = await f.paid();
  const handle = f.service.managed!.handle!;
  vi.stubGlobal("caches", undefined);
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === ROUTE_URL) {
      const req = Object.assign(new PassThrough(), { method: request.method, url: url.pathname + url.search, headers: Object.fromEntries(request.headers), socket: { remoteAddress: "198.51.100.1" } }) as unknown as IncomingMessage;
      (req as unknown as PassThrough).end("");
      let status = 0, text = "";
      const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as unknown as ServerResponse;
      await handle(req, res, url, { publicUrl: ROUTE_URL, json: (r, code, data) => { r.writeHead(code); r.end(JSON.stringify(data)); }, readJson: async () => ({}), clientIp: () => "198.51.100.1" });
      return new Response(text, { status });
    }
    if (url.origin === c.managed!.upstream) {
      // a paused machine's public port answers with the provider's own page
      if (f.api.machines.get(c.serverId!)!.state !== "running") return new Response(PAGE, { status: 503, headers: { "content-type": "text/plain" } });
      return new Response("ok", { status: 200, headers: { server: "machine" } });
    }
    throw new Error(`unexpected request to ${url.href}`);
  });
  const env: EdgeEnv = { ROUTE_URL, EDGE_TOKEN: TOKEN, PUBLIC_DOMAIN: DOMAIN };
  const send = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${c.origin}${path}`, init), env, { waitUntil() {} });
  return { f, c, send };
}

describe("a machine the provider paused while the account service reads it as running", () => {
  it("never shows the provider's page: the edge says waking, and the next pass resumes the machine", async () => {
    const { f, c, send } = await edged();
    f.api.machines.get(c.serverId!)!.state = "suspended";
    const first = await send("/api/health");
    expect(first.status).toBe(503);
    expect(first.headers.get("x-dusk-cloud-power")).toBe("waking");
    expect(await first.text()).not.toMatch(/instabox|sandbox/i);
    expect(f.audit.entries(c.id).map(e => `${e.action}:${e.actor}`)).toContain("provider_page_seen:edge");
    for (let k = 0; k < 10 && f.api.machines.get(c.serverId!)!.state !== "running"; k++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
    expect(f.api.machines.get(c.serverId!)!.state).toBe("running");
    for (let k = 0; k < 10 && (c.managed!.wakeStartedAt !== null || c.managed!.pausedSeenAt != null); k++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
    const after = await send("/api/health");
    expect(after.status).toBe(200);
    expect(f.service.managed!.view(c).waking).toBeFalsy();
  }, 30_000);

  it("does not reach for the provider's page when the home's own 503 says it is asleep", async () => {
    const { f, c, send } = await edged();
    vi.stubGlobal("fetch", async (input: Request | string) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === c.managed!.upstream) return new Response("asleep", { status: 503, headers: { "x-dusk-cloud-power": "asleep", "content-type": "text/plain" } });
      return Response.json({ upstream: c.managed!.upstream, awake: true });
    });
    const answer = await send("/api/health");
    expect(answer.headers.get("x-dusk-cloud-power")).toBe("asleep");
    expect(f.audit.entries(c.id).map(e => e.action)).not.toContain("provider_page_seen");
  });

  it("the account service's wake route reads a running cloud with a paused page as waking, and resumes it", async () => {
    const { f, c } = await edged();
    f.api.machines.get(c.serverId!)!.state = "suspended";
    expect(f.service.managed!.providerPageSeen!(c)).toBe(true);
    expect(f.service.managed!.view(c).waking).toBe(true);
    for (let k = 0; k < 10 && f.api.machines.get(c.serverId!)!.state !== "running"; k++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
    expect(f.api.machines.get(c.serverId!)!.state).toBe("running");
  }, 30_000);
});

describe("the provider refusing to resume any machine for its own billing", () => {
  it("is no failure of the cloud, tells the operator once, retries by itself and recovers with one all-clear", async () => {
    const f = await homeFixture({ settings: { publicDomain: DOMAIN }, edgeToken: TOKEN });
    const { c } = await f.paid();
    const other = (await f.paid("acct_2")).c;
    await f.asleep(c);
    await f.asleep(other);
    f.api.pauseWorkspace("payment_failed");
    for (const cloud of [c, other]) { cloud.wantPower = "on"; cloud.wakeRequestedAt = f.now(); }
    for (let k = 0; k < 6; k++) { f.advance(3 * 60_000); for (const cloud of [c, other]) cloud.nextAttemptAt = 0; await f.service.reconcile(); }
    expect(c.status).toBe("sleeping");
    expect(c.attempts).toBe(0);
    expect(other.attempts).toBe(0);
    expect(f.outages.filter(o => o.action === "outage_open")).toHaveLength(1);
    expect(f.service.managed!.view(c).waking).toBe(true);
    f.api.pauseWorkspace(null);
    for (let k = 0; k < 12 && (c.status !== "running" || other.status !== "running"); k++) { f.advance(3 * 60_000); for (const cloud of [c, other]) cloud.nextAttemptAt = 0; await f.service.reconcile(); }
    expect(c.status).toBe("running");
    expect(other.status).toBe("running");
    expect(f.outages[0]).toMatchObject({ action: "outage_open", key: "provider-paused" });
    expect(f.outages.filter(o => o.action === "outage_open")).toHaveLength(1);
    expect(f.outages.filter(o => o.action === "outage_close").length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
