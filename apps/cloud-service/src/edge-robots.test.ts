// the public edge (edge/worker.js) keeps every home address out of search results: each answer says noindex, except a
// websocket upgrade, which passes through untouched
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { ROBOTS, type EdgeEnv } from "../edge/worker.js";

const ROUTE_URL = "https://dash.example.test", DOMAIN = "desktops.example.com", UPSTREAM = "https://home.example";
const env: EdgeEnv = { ROUTE_URL, EDGE_TOKEN: "e".repeat(40), PUBLIC_DOMAIN: DOMAIN };
const ctx = { waitUntil() {} };
const label = (n: number) => `d${n.toString(16).padStart(20, "0")}`;
afterEach(() => vi.unstubAllGlobals());

function setup(route: Response | (() => Response), home: () => Response = () => new Response("ok", { headers: { server: "machine" } })) {
  vi.stubGlobal("caches", undefined);
  vi.stubGlobal("fetch", async (input: Request | string) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin === ROUTE_URL) return typeof route === "function" ? route() : route.clone();
    if (url.origin === UPSTREAM) return home();
    throw new Error(`unexpected request to ${url.href}`);
  });
}
const send = (host: string, path = "/", init: RequestInit = {}) => worker.fetch(new Request(`https://${host}${path}`, init), env, ctx);

describe("the edge says noindex", () => {
  it("on an awake home's own answer, with its status and body", async () => {
    setup(() => Response.json({ upstream: UPSTREAM, awake: true }));
    const response = await send(`${label(1)}.${DOMAIN}`, "/api/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("x-robots-tag")).toBe(ROBOTS);
    expect(response.headers.get("server")).toBeNull();
  });

  it("on a sleeping home's 503, an unknown label's 404, a malformed host's 404 and a deleted home's 410", async () => {
    setup(() => Response.json({ upstream: UPSTREAM, awake: false, wakeable: true }));
    const asleep = await send(`${label(2)}.${DOMAIN}`, "/api/health");
    expect(asleep.status).toBe(503);
    expect(asleep.headers.get("x-dusk-cloud-power")).toBe("asleep");
    expect(asleep.headers.get("x-robots-tag")).toBe(ROBOTS);

    setup(() => new Response("{}", { status: 404 }));
    const unknown = await send(`${label(3)}.${DOMAIN}`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("x-robots-tag")).toBe(ROBOTS);
    const malformed = await send(`nothing.${DOMAIN}`);
    expect(malformed.status).toBe(404);
    expect(malformed.headers.get("x-robots-tag")).toBe(ROBOTS);

    setup(() => new Response("{}", { status: 410 }));
    const gone = await send(`${label(4)}.${DOMAIN}`);
    expect(gone.status).toBe(410);
    expect(gone.headers.get("x-robots-tag")).toBe(ROBOTS);
  });

  it("never touches a websocket upgrade", async () => {
    const upgrade = new Response(null);
    Object.defineProperty(upgrade, "status", { value: 101 });
    setup(() => Response.json({ upstream: UPSTREAM, awake: true }), () => upgrade);
    const response = await send(`${label(5)}.${DOMAIN}`, "/ws", { headers: { upgrade: "websocket" } });
    expect(response).toBe(upgrade);
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });
});
