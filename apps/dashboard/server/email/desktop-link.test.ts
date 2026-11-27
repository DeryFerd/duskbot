import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createDashboardApp } from "../app.ts";
import { createTestMailbox, memoryMailer, type Mailer } from "../auth/mail.ts";
import { cleanLinkAddress, DESKTOP_LINK_LIMITS, DESKTOP_LINK_PATH } from "./desktop-link.ts";

const TOKEN = "t".repeat(40), origin = "http://dashboard.test";

describe("desktop link for phone visitors", () => {
  let server: Server, app: ReturnType<typeof createDashboardApp>, dataDir: string, url: string;
  async function boot(mailer: Mailer) {
    dataDir = mkdtempSync(join(tmpdir(), "dusk-desktop-link-"));
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, trustProxy: true, testMail: createTestMailbox({ readable: true }), admin: { emails: [], env: { DUSK_OPS_TOKEN: TOKEN } } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  const ask = (body: unknown, from: string | null = origin, ip = "203.0.113.7") => fetch(`${url}${DESKTOP_LINK_PATH}`, { method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(from ? { origin: from } : {}) }, body: JSON.stringify(body) });
  afterEach(async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("mails the download page to the address typed, with no account", async () => {
    const mailer = memoryMailer();
    await boot(mailer);
    const answer = await ask({ email: "  Sam@Example.com " });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true });
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]).toMatchObject({ to: "sam@example.com", subject: "dusk bot for your computer" });
    expect(mailer.outbox[0]!.text).toContain("/download");
    expect(mailer.outbox[0]!.transactional).toBeUndefined();
  });

  it("keeps a test address's email in the test mailbox, never the provider", async () => {
    const mailer = memoryMailer();
    await boot(mailer);
    expect((await ask({ email: "phone-link@qa.dusk.test" })).status).toBe(200);
    const kept = await (await fetch(`${url}/v1/ops/test-mail?to=phone-link%40qa.dusk.test`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { subject: string; link: string };
    expect(kept.subject).toBe("dusk bot for your computer");
    expect(kept.link).toMatch(/\/download$/);
    expect(mailer.outbox).toEqual([]);
  });

  it("turns away what is not a deliverable address, a robot and another site", async () => {
    const mailer = memoryMailer();
    await boot(mailer);
    for (const [i, email] of ["", "sam", "sam@", "sam@localhost", "x@y.invalid", "x@y.test", 42].entries()) {
      const answer = await ask({ email }, origin, `192.0.2.${i + 1}`);
      expect(answer.status, String(email)).toBe(400);
      expect(await answer.json()).toEqual({ ok: false, error: "bad_email" });
    }
    expect((await ask({ email: "sam@example.com", website: "spam.biz" }, origin, "203.0.113.8")).status).toBe(200);
    expect((await ask({ email: "sam@example.com" }, "https://elsewhere.test", "203.0.113.9")).status).toBe(403);
    expect(mailer.outbox).toEqual([]);
  });

  it("sends an address at most twice a day and lets one network ask five times an hour", async () => {
    const mailer = memoryMailer();
    await boot(mailer);
    for (let i = 0; i < 3; i++) expect((await ask({ email: "sam@example.com" })).status).toBe(200);
    expect(mailer.outbox).toHaveLength(DESKTOP_LINK_LIMITS.perAddressDay);
    for (let i = 3; i < DESKTOP_LINK_LIMITS.perIpHour; i++) expect((await ask({ email: `n${i}@example.com` })).status).toBe(200);
    const sixth = await ask({ email: "late@example.com" });
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ ok: false, error: "too_many" });
    expect((await ask({ email: "other@example.com" }, origin, "198.51.100.4")).status).toBe(200);
  });

  it("says mail is off when the provider fails, so the page can open the mail app instead", async () => {
    await boot({ async send() { throw new Error("down"); } });
    const answer = await ask({ email: "sam@example.com" });
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ ok: false, error: "mail_off" });
  });
});

it("checks a desktop link address", () => {
  expect(cleanLinkAddress("A@B.co")).toBe("a@b.co");
  expect(cleanLinkAddress("qa-1@qa.dusk.test")).toBe("qa-1@qa.dusk.test");
  expect(cleanLinkAddress("a b@c.co")).toBeNull();
  expect(cleanLinkAddress(`${"a".repeat(65)}@c.co`)).toBeNull();
});
