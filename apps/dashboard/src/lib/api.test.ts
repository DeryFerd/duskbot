import { afterEach, expect, test, vi } from "vitest";
import { CSRF_COOKIE, CSRF_HEADER } from "../data/wire";

const catalog = {
  licenses: [], desktops: [], bundles: [], regions: [], defaultRegion: "eu", yearlyDiscountPercent: 0, freeWorkUntil: null,
  dedicated: { baseCents: 0, perVcpuCents: 0, perGbRamCents: 0, includedDiskGb: 0, per20GbDiskCents: 0, vcpu: { min: 1, max: 8, step: 1 }, ramGb: { min: 1, max: 8, step: 1 }, diskGb: { min: 10, max: 100, step: 10 }, sizes: [] },
};

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

test("plan checkouts send their source next to the wire kind", async () => {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => Response.json(path.endsWith("catalog") ? catalog : { checkoutUrl: "https://checkout.example.test", checkoutId: "checkout" }));
  vi.stubGlobal("fetch", fetch);
  const { api } = await import("./api");
  await api.checkout({ kind: "plan", source: "dash_routines", bundle: null, selection: { desktop: "shared-s", license: "personal", members: 1, interval: "month", region: "eu", size: null } });
  const requests = fetch.mock.calls.filter(([path]) => path.endsWith("checkout"));
  expect(JSON.parse((requests[0]![1] as RequestInit).body as string)).toEqual({ kind: "cart", source: "dash_routines", cart: { interval: "month", license: { kind: "none" }, desktop: { kind: "shared_s", region: "eu" } } });
});

test("Slack wake uses the cloud route and PUT includes the session and CSRF header", async () => {
  const answer = { available: true, enabled: false, state: "off", bots: 0, buffered: 0 };
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json(answer));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=fixture-csrf` });
  const { api } = await import("./api");
  expect(await api.slackWake("desktop/id")).toEqual(answer);
  await api.setSlackWake("desktop/id", true);
  expect(fetch.mock.calls[0]![0]).toBe("/v1/clouds/desktop%2Fid/slack-wake");
  expect(fetch.mock.calls[1]).toEqual(["/v1/clouds/desktop%2Fid/slack-wake", expect.objectContaining({ method: "PUT", credentials: "same-origin", body: JSON.stringify({ enabled: true }), headers: expect.objectContaining({ [CSRF_HEADER]: "fixture-csrf" }) })]);
});

test("catalog wake mapping preserves measured stats under dashboard desktop ids", async () => {
  const { catalogFromWire } = await import("../data/live");
  const measured = { shared_s: { medianMs: 700, p90Ms: 1500, samples: 30 }, shared_m: { medianMs: 4200, p90Ms: 6000, samples: 40 }, dedicated: { medianMs: 12_000, p90Ms: 20_000, samples: 50 } };
  const wire = { v: 1, currency: "USD", graceDays: 7, ...catalog } as const;
  expect(catalogFromWire(wire).wake).toBeUndefined();
  expect(catalogFromWire({ ...wire, wake: measured }).wake).toEqual({ "shared-s": measured.shared_s, "shared-m": measured.shared_m, dedicated: measured.dedicated });
});

test("fixtures accept checkout sources and retain the Slack wake switch state", async () => {
  vi.stubGlobal("location", { search: "?fixture=cloud" });
  vi.stubGlobal("sessionStorage", { setItem: vi.fn() });
  const { api } = await import("./api");
  const { clouds } = await api.clouds();
  expect((await api.catalog()).wake).toBeUndefined();
  expect(await api.slackWake(clouds[0]!.id)).toEqual({ available: true, enabled: false, state: "off", bots: 0, buffered: 0 });
  expect((await api.setSlackWake(clouds[0]!.id, true)).enabled).toBe(true);
  expect((await api.slackWake(clouds[0]!.id)).enabled).toBe(true);
  expect(await api.checkout({ kind: "plan", source: "dash_billing", bundle: "starter", selection: { desktop: "shared-s", license: "personal", members: 1, interval: "month", region: "eu-central", size: null } })).toEqual({ url: "", id: expect.any(String) });
});

test("a plan change that charges now is applied only at the amount the person was shown", async () => {
  const overview = { subscriptions: [{ id: "sub1", status: "active", createdAt: 1, bundle: null, totalCents: 1000, currentPeriodEnd: 2, cancelAtPeriodEnd: false, cart: { interval: "month", license: { kind: "team", members: 3 }, desktop: { kind: "none" } } }], clouds: [], invoices: { invoices: [] } };
  let chargeNowCents = 1250;
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => Response.json(
    path.endsWith("catalog") ? catalog : path.endsWith("overview") ? overview : path.endsWith("/preview") ? { v: 1, quote: {}, timing: "now", chargeNowCents, taxCents: 150, effectiveAt: 1, nextChargeCents: 1000, nextChargeAt: 2, confirmation: "confirm-1", expiresAt: 3 } : {}));
  vi.stubGlobal("fetch", fetch);
  const { api } = await import("./api");
  await api.billing();
  const selection = { license: "team", members: 3, desktop: "none", size: null, region: "eu", interval: "month" } as const;
  expect(await api.changeCharge(selection)).toEqual({ timing: "now", todayUsd: 12.5, taxUsd: 1.5, effectiveAt: 1, nextUsd: 10, nextAt: 2 });
  expect(fetch.mock.calls.some(([path]) => path.endsWith("/change"))).toBe(false);
  await expect(api.changePlan(selection)).rejects.toMatchObject({ code: "price_changed" });
  await expect(api.changePlan(selection, 10)).rejects.toMatchObject({ code: "price_changed" });
  expect(fetch.mock.calls.some(([path]) => path.endsWith("/change"))).toBe(false);
  await api.changePlan(selection, 12.5);
  expect(fetch.mock.calls.filter(([path]) => path.endsWith("/change")).map(([, init]) => JSON.parse(init!.body as string))).toEqual([{ confirmation: "confirm-1" }]);
  chargeNowCents = 0;
  await api.changePlan(selection);
  expect(fetch.mock.calls.filter(([path]) => path.endsWith("/change"))).toHaveLength(2);
});

test("deleting a managed cloud's data posts JSON with the CSRF header to the delete-data routes", async () => {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => Response.json(path.endsWith("/confirm") ? { ok: true, deleteScheduledAt: 5 } : { ok: true }));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=fixture-csrf` });
  const { api } = await import("./api");
  const token = "a".repeat(43);
  await api.askDeleteData("cloud/1");
  expect((await api.confirmDeleteData("cloud/1", token)).deleteScheduledAt).toBe(5);
  await api.cancelDeleteData("cloud/1");
  expect(fetch.mock.calls.map(([path, init]) => [path, init!.method, init!.body, (init!.headers as Record<string, string>)[CSRF_HEADER]])).toEqual([
    ["/v1/clouds/cloud%2F1/delete-data", "POST", "{}", "fixture-csrf"],
    ["/v1/clouds/cloud%2F1/delete-data/confirm", "POST", JSON.stringify({ token }), "fixture-csrf"],
    ["/v1/clouds/cloud%2F1/delete-data/cancel", "POST", "{}", "fixture-csrf"],
  ]);
});

test("reauth_required and the other delete-data codes come back as their own code with words for the page", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "reauth_required", code: "reauth_required" }, { status: 403 })));
  const { api } = await import("./api");
  const { deleteDataError, needsSignIn } = await import("../data/delete-data");
  const error = await api.askDeleteData("c").catch((e: unknown) => e);
  expect(needsSignIn(error)).toBe(true);
  const { ApiError } = await import("./api");
  expect(deleteDataError(new ApiError("billing_active", 409, "billing_active"))).toMatch(/cancel it in account, plan & billing first/);
  expect(deleteDataError(new ApiError("confirmation_required", 409, "confirmation_required"))).toMatch(/expired or was already used/);
  expect(deleteDataError(new ApiError("weird", 500, "weird"))).toBe("that did not work. try again.");
});

test("an empty server failure uses a calm fallback", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  const { api } = await import("./api");
  await expect(api.me()).rejects.toMatchObject({ status: 500, message: "something went wrong on our side. try again." });
});

test("a 2xx answer with no json rejects instead of resolving null, so pages never read fields off null", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })));
  const { api, ApiError } = await import("./api");
  const workspaces = api.workspaces();
  await expect(workspaces).rejects.toBeInstanceOf(ApiError);
  await expect(workspaces).rejects.toMatchObject({ status: 502, code: "bad_response" });
  await expect(api.workspace("ws1")).rejects.toBeInstanceOf(ApiError);
});

test("a body read cut off by an abort rejects as an abort, not as an empty answer", async () => {
  const ctl = new AbortController();
  const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"workspaces":[')); } });
  const response = new Response(body, { status: 200 });
  vi.spyOn(response, "json").mockImplementation(() => { ctl.abort(); return Promise.reject(new DOMException("aborted", "AbortError")); });
  vi.stubGlobal("fetch", vi.fn(async () => response));
  const { api } = await import("./api");
  await expect(api.workspaces(ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
});
