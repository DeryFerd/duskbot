import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "./app.ts";
import { ACCOUNT_RECAP_PATH, EMPTY_RECAP, type AccountRecap } from "../../../shared/account-recap.ts";
import type { AppGrant, EmailStartAnswer, EnrollGrantAnswer } from "../../../shared/account-api.ts";
import { SIGNATURE_HEADERS, signedPayload, type EnrollAnswer, type WorkspaceReport } from "../../../shared/dashboard-protocol.ts";
import { memoryMailer } from "./auth/mail.ts";

async function body<T>(response: Response | Promise<Response>): Promise<T> { return (await response).json() as Promise<T>; }
const RECAP_KEYS = Object.keys(EMPTY_RECAP).sort();
const BOT_KEYS = ["body", "color", "id", "name", "replies"];

describe("the cancel flow's recap", () => {
  let dataDir: string, url: string, time: number, server: Server, nonce: number, seq: number;
  let app: ReturnType<typeof createDashboardApp>;
  let mailer: ReturnType<typeof memoryMailer>;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dusk-recap-test-"));
    time = Date.now(); nonce = 0; seq = 0; mailer = memoryMailer();
    app = createDashboardApp({ dataDir, publicUrl: "http://127.0.0.1:7480", mailer, staticDir: null, now: () => time });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not start.");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    app.close();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });
  function call(path: string, data?: unknown, headers: Record<string, string> = {}) {
    return fetch(url + path, { method: data === undefined ? "GET" : "POST", headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  const code = (email: string) => mailer.outbox.findLast(item => item.to === email)!.text.match(/\b\d{8}\b/)![0];
  const bearer = (grant: AppGrant) => ({ authorization: `Bearer ${grant.accessToken}` });
  async function appLogin(email: string): Promise<AppGrant> {
    const started = await body<EmailStartAnswer>(call("/api/cloud/app/sign-in/start", { email, deviceName: "Fixture Mac", platform: "darwin", appVersion: "1.0.0" }));
    return body<AppGrant>(call("/api/cloud/app/sign-in/verify", { attempt: started.attempt, code: code(email) }));
  }
  async function webLogin(email: string): Promise<string> {
    const { attempt } = await body<{ attempt: string }>(call("/v1/auth/start", { email }));
    const verified = await call("/v1/auth/verify", { attempt, code: code(email) });
    expect(verified.status).toBe(200);
    return verified.headers.get("set-cookie")!.split(";")[0]!;
  }
  /** a computer of the owner's that sends one report with these sections */
  async function computer(owner: AppGrant, sections: Partial<WorkspaceReport>) {
    const grant = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(owner)));
    const keys = generateKeyPairSync("ed25519");
    const input = { v: 1, publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), name: "Studio Mac", kind: "mac", version: "1.0.0", enrollToken: grant.enrollToken };
    const signed = (path: string, raw: string, extra: Record<string, string> = {}) => {
      const at = time + ++nonce;
      const signature = sign(null, Buffer.from(signedPayload("POST", path, at, createHash("sha256").update(raw).digest("hex"))), keys.privateKey).toString("base64");
      return fetch(url + path, { method: "POST", body: raw, headers: { "content-type": "application/json", [SIGNATURE_HEADERS.time]: String(at), [SIGNATURE_HEADERS.signature]: signature, ...extra } });
    };
    const enrolled = await body<EnrollAnswer>(signed("/v1/enroll", JSON.stringify(input)));
    const report: WorkspaceReport = { v: 1, seq: ++seq, at: time, workspace: { name: "Studio Mac", kind: "mac", version: "1.0.0", platform: "darwin" }, ...sections };
    expect((await signed("/v1/report", JSON.stringify(report), { [SIGNATURE_HEADERS.workspace]: enrolled.workspaceId })).status).toBe(200);
  }
  const totals = (turns: number) => ({ turns, tokens: turns * 10, costUsd: null });
  const routine = (id: string, name: string, paused: boolean) => ({ id, name, schedule: "Every day at 8:00", paused, nextRunAt: null, lastRunAt: null });
  const bot = (id: string, name: string, color: string, routines: ReturnType<typeof routine>[] = []) =>
    ({ id, name, color, body: "clover", model: null, engine: null, computer: null, busy: false, lastActiveAt: null, routines });

  it("gives the owner their own numbers by web session or app sign-in, a stranger nothing, and the signed out a 401", async () => {
    const owner = await appLogin("owner@example.test"), stranger = await appLogin("stranger@example.test");
    await computer(owner, {
      bots: [bot("nova", "Nova", "blue", [routine("r1", "Ask the bank about the loan", false), routine("r2", "Paused secret", true)]), bot("quill", "Quill", "purple")],
      activity: { from: "2025-11-28", to: "2026-11-27", timeZone: "UTC", days: [{ date: "2026-11-01", ...totals(5) }, { date: "2026-11-02", ...totals(3) }],
        byBot: [{ botId: "nova", botName: "Nova", ...totals(6) }, { botId: "quill", botName: "Quill", ...totals(2) }], byModel: [], totals: totals(8) },
      apps: { available: true, complete: true, services: [{ slug: "gmail", connected: true, pending: false }, { slug: "linear", connected: false, pending: true }] },
    });
    await computer(owner, { apps: { available: true, complete: true, services: [{ slug: "gmail", connected: true, pending: false }, { slug: "github", connected: true, pending: false }] } });
    await computer(stranger, { bots: [bot("rivet", "Rivet", "orange")] });

    const signedOut = await call(ACCOUNT_RECAP_PATH);
    expect(signedOut.status).toBe(401);
    expect((await call(ACCOUNT_RECAP_PATH, undefined, { authorization: `Bearer omc_${"x".repeat(43)}` })).status).toBe(401);

    const byApp = await call(ACCOUNT_RECAP_PATH, undefined, bearer(owner));
    expect(byApp.status).toBe(200);
    expect(byApp.headers.get("cache-control")).toBe("no-store");
    const raw = await byApp.text(), recap = JSON.parse(raw) as AccountRecap;
    const nova = { id: "nova", name: "Nova", color: "blue", body: "clover", replies: 6 };
    expect(recap).toEqual({ v: 1, since: time, bots: 2, crew: [nova, { id: "quill", name: "Quill", color: "purple", body: "clover", replies: 2 }], topBot: nova,
      replies: 8, activeDays: 2, longestStreak: 2, routines: 1, apps: 2, computers: 2 });
    expect(Object.keys(recap).sort()).toEqual(RECAP_KEYS);
    for (const item of [...recap.crew, recap.topBot!]) expect(Object.keys(item).sort()).toEqual(BOT_KEYS);
    for (const secret of ["bank", "loan", "Paused secret", "linear", "Rivet", "stranger@"]) expect(raw).not.toContain(secret);

    const cookie = await webLogin("owner@example.test");
    expect(await body<AccountRecap>(call(ACCOUNT_RECAP_PATH, undefined, { cookie }))).toEqual(recap);

    const theirs = await body<AccountRecap>(call(ACCOUNT_RECAP_PATH, undefined, bearer(stranger)));
    expect(theirs).toMatchObject({ bots: 1, replies: 0, routines: 0, apps: 0, computers: 1, topBot: null });
    const nobody = await webLogin("nobody@example.test");
    expect(await body<AccountRecap>(call(ACCOUNT_RECAP_PATH, undefined, { cookie: nobody }))).toEqual({ ...EMPTY_RECAP, since: time });
  });
});
