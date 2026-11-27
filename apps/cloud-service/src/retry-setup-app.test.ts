// the admin panel's "retry setup now" through the whole dashboard app: owner and admin only, refused where the scheduled
// retry would not run, and written to both the panel's audit and the managed audit
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../../../shared/account-api.ts";
import { createBilling } from "../../dashboard/server/billing/index.ts";
import { createDashboardApp } from "../../dashboard/server/app.ts";
import { memoryMailer } from "../../dashboard/server/auth/mail.ts";
import { memorySink } from "../../dashboard/server/analytics/sink.ts";
import type { BillingState } from "../../dashboard/server/billing/store.ts";
import type { StoredCloud } from "../../dashboard/server/clouds/types.ts";
import type { AuditEntry } from "./audit.ts";
import { startFakeInstaboxApi } from "./fake-instabox-api.ts";

vi.mock("../../dashboard/server/billing/index.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../../dashboard/server/billing/index.ts")>();
  return { ...actual, createBilling: vi.fn(actual.createBilling) };
});
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dusk-retry-setup-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let time = Date.UTC(2026, 10, 9, 12);
  const now = () => time, mailer = memoryMailer(), sink = memorySink(now);
  const api = await startFakeInstaboxApi({ now }); cleanup.push(() => api.close());
  api.onExec(({ machine, cmd }) => {
    if (cmd.includes("omb-home start") && !machine.volume.size) machine.volume.set("data/.omb-cloud-home.json", Buffer.from(JSON.stringify({ version: 1, machine: machine.metadata["omb.cloud"] })));
    if (cmd.includes("omb-home start")) machine.volume.set(`data/${CLOUD_HOME.dataName}/config.json`, Buffer.from("{}"));
    return null;
  });
  for (const key of ["DUSK_BILLING_PROVIDER", "DUSK_CLOUD_PROVIDER", "DUSK_POOL_DRIVER", "DUSK_CLOUD_SEAL_KEY", "DUSK_DODO_PRODUCTS"]) vi.stubEnv(key, undefined);
  vi.stubEnv("DUSK_MANAGED", "1"); vi.stubEnv("INSTABOX_API_KEY", api.key); vi.stubEnv("INSTABOX_BASE_URL", api.baseUrl);
  vi.stubEnv("DUSK_MANAGED_HOME_PACKAGE_URL", "https://packages.example.test/home.tgz"); vi.stubEnv("DUSK_MANAGED_HOME_PACKAGE_SHA256", "b".repeat(64)); vi.stubEnv("DUSK_MANAGED_BACKUP_MIN_FREE_GB", "1");
  vi.stubEnv("DUSK_ADMIN_EMAILS", "admin@example.test"); vi.stubEnv("DUSK_GROWTH_ADMIN_EMAILS", "growth@example.test");
  // the home's health check: down while `homeDown`, so a first setup lands in its error state
  const health = { homeDown: true };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname.endsWith(".instabox.tech")) {
      if (url.pathname === "/api/cloud/health" && health.homeDown) return new Response("down", { status: 503 });
      const body = url.pathname === "/api/cloud/health" ? { v: 1 } : url.pathname === "/api/cloud/power" ? { v: 1, idle: false, busy: ["turn"], nextDueAt: null }
        : url.pathname === "/api/cloud/entitlement" ? { ok: true, expiresAt: now() + 86_400_000 } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  };
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address.");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const app = createDashboardApp({ dataDir: dir, publicUrl: origin, mailer, staticDir: null, now, fetch: fetcher, analytics: { sink } });
  cleanup.push(() => app.close());
  server.on("request", app.handle);
  const billing = vi.mocked(createBilling).mock.results.at(-1)!.value as ReturnType<typeof createBilling>;
  const csrf = new Map<string, string>();
  const page = (path: string, body?: unknown, cookie?: string, options: { csrf?: boolean } = {}) => fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie, ...(options.csrf === false ? {} : { [CSRF_HEADER]: csrf.get(cookie) ?? "" }) } : {}), origin, "x-dusk-admin-tests": "show" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function login(email: string) {
    const { attempt } = await (await page("/v1/auth/start", { email })).json() as { attempt: string };
    const code = mailer.outbox.findLast(m => m.to === email && /\b\d{8}\b/.test(m.text))!.text.match(/\b\d{8}\b/)![0];
    const verify = await page("/v1/auth/verify", { attempt, code });
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }
  /** a paid managed cloud whose first setup never sees its home come up, left until its setup is in error */
  async function erroredCloud(email: string) {
    const cookie = await login(email);
    expect((await page("/v1/billing/checkout", { kind: "cart", cart: { interval: "month", license: { kind: "none" }, desktop: { kind: "shared_s", region: "us-west-2" } } }, cookie)).status).toBe(200);
    const stored = (JSON.parse(readFileSync(join(dir, "billing.json"), "utf8")) as BillingState).checkouts.at(-1)!;
    for (const d of billing.fake!.complete(stored.providerSessionId!)) expect((await fetch(`${origin}/v1/billing/webhooks/dodo`, { method: "POST", headers: { "content-type": "application/json", ...d.headers }, body: new Uint8Array(d.body) })).status).toBe(200);
    const cloud = billing.clouds.get(stored.cloudId!)!;
    for (let n = 0; n < 120 && cloud.status !== "error"; n++) { time += 5 * 60_000; cloud.nextAttemptAt = 0; await billing.clouds.reconcile(); }
    expect(cloud).toMatchObject({ backend: "managed", status: "error" });
    cloud.nextAttemptAt = 0; await billing.clouds.reconcile();
    expect(cloud.status).toBe("error");
    return cloud;
  }
  const managedAudit = (cloudId: string): AuditEntry[] => {
    const file = readdirSync(dir, { recursive: true, encoding: "utf8" }).find(name => name.endsWith("managed-audit.jsonl"))!;
    return readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as AuditEntry).filter(e => e.cloudId === cloudId);
  };
  const reconcile = (c: StoredCloud) => { c.nextAttemptAt = 0; return billing.clouds.reconcile(); };
  return { billing, sink, health, page, login, erroredCloud, managedAudit, reconcile };
}

it("retries a setup in error from the panel for the admin only, offers it only then, and audits it in both logs", async () => {
  const f = await fixture();
  const cloud = await f.erroredCloud("someone@example.test");
  const admin = await f.login("admin@example.test"), growth = await f.login("growth@example.test"), other = await f.login("other@example.test");
  const path = `/v1/admin/clouds/${cloud.id}/retry-setup`, body = { confirm: cloud.name };
  expect((await f.page(path, body)).status).toBe(401);
  expect((await f.page(path, body, other)).status).toBe(403);
  expect((await f.page(path, body, growth)).status).toBe(403);
  expect((await f.page(path, body, admin, { csrf: false })).status).toBe(403);
  expect((await f.page(path, {}, admin)).status).toBe(400);
  expect(cloud.managed!.setupRetryAskedAt ?? null).toBeNull();
  // the row offers it for a setup in error
  const rows = await (await f.page("/v1/admin/clouds?status=all", undefined, admin)).json() as { clouds: Array<{ id: string; actions: Record<string, boolean> }> };
  expect(rows.clouds.find(row => row.id === cloud.id)!.actions).toMatchObject({ retrySetup: true, resume: false });

  f.health.homeDown = false;
  const first = await f.page(path, body, admin);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ already: false });
  // the retry's own pass started the attempt; a second ask while it runs changes nothing
  await f.billing.clouds.reconcile();
  for (let n = 0; n < 30 && cloud.status !== "running"; n++) await f.reconcile(cloud);
  expect(cloud).toMatchObject({ status: "running", error: null, setupStep: null });
  const again = await f.page(path, body, admin);
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ code: "not_available" });

  const asked = f.managedAudit(cloud.id).filter(e => e.action === "setup_retry_asked");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ actor: "operator", reason: "admin_panel" });
  const panel = (await f.sink.auditLog(100)).filter(e => e.action === "cloud.retry_setup");
  expect(panel).toHaveLength(1);
  expect(panel[0]).toMatchObject({ target: cloud.id, detail: { ok: true, already: false } });
});

it("refuses the panel's retry on a suspended cloud and on one whose plan ended, and audits the refusal", async () => {
  const f = await fixture();
  const cloud = await f.erroredCloud("someone@example.test");
  const admin = await f.login("admin@example.test");
  const path = `/v1/admin/clouds/${cloud.id}/retry-setup`, body = { confirm: cloud.id };
  cloud.suspended = "abuse";
  const suspended = await f.page(path, body, admin);
  expect(suspended.status).toBe(409);
  expect(await suspended.json()).toMatchObject({ code: "not_available" });
  cloud.suspended = null;
  const sub = f.billing.store.state.subscriptions.find(s => s.cloudId === cloud.id)!;
  sub.status = "ended"; sub.currentPeriodEnd = cloud.updatedAt;
  const ended = await f.page(path, body, admin);
  expect(ended.status).toBe(409);
  expect(await ended.json()).toMatchObject({ code: "no_plan" });
  expect(cloud.managed!.setupRetryAskedAt ?? null).toBeNull();
  expect(f.managedAudit(cloud.id).map(e => e.action)).not.toContain("setup_retry_asked");
  expect((await f.sink.auditLog(100)).find(e => e.action === "cloud.retry_setup")).toMatchObject({ detail: { ok: false, code: "no_plan" } });
});
