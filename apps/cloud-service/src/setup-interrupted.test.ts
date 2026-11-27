import { expect, it, vi } from "vitest";
import type { StoredSubscription } from "../../dashboard/server/billing/store.ts";
import { INSTABOX_SETUP_STATUS } from "./home.ts";
import { DAY_MS } from "./retention.ts";
import { homeFixture, plan, SHA } from "./test-fixture.ts";

type Fixture = Awaited<ReturnType<typeof homeFixture>>;

function ordered(f: Fixture) {
  const c = f.service.order({ ...plan, accountId: "acct_1", name: "My Cloud", color: null, region: "eu" });
  const sub = { id: "sub_setup", accountId: "acct_1", cloudId: c.id, status: "active", currentPeriodEnd: f.now() + 30 * DAY_MS, updatedAt: f.now() } as unknown as StoredSubscription;
  f.subscriptions.push(sub);
  f.service.activate(c.id, sub.id, plan);
  return { c, sub };
}
const end = (f: Fixture, sub: StoredSubscription) => Object.assign(sub, { status: "ended", currentPeriodEnd: f.now() });
const renew = (f: Fixture, sub: StoredSubscription) => Object.assign(sub, { status: "active", currentPeriodEnd: f.now() + 30 * DAY_MS });
const creates = (f: Fixture) => f.api.requests.filter(r => r.method === "POST" && r.path === "/v1/machines").length;

it("a setup script that fails once gets a fresh machine, and the failed one is retired, not used", async () => {
  const f = await homeFixture();
  let failures = 0;
  f.api.onExec(({ machine, cmd }) => {
    if (cmd.includes("setsid nohup") && failures++ === 0) { machine.files.set(INSTABOX_SETUP_STATUS, Buffer.from("1\n")); return { exitCode: 0, stdout: "launched\n" }; }
    return null;
  });
  const { c } = ordered(f);
  await f.settle(c, x => x.status === "running", 30);
  expect(c).toMatchObject({ setupStep: null, error: null });
  expect(c.managed!.installed).toBe(SHA);
  expect(creates(f)).toBe(2);
  expect(c.managed!.retired).toHaveLength(1);
  expect(c.managed!.retired[0]!.serverId).not.toBe(c.serverId);
  expect(f.audit.entries(c.id).map(e => e.action)).toContain("setup_failed");
});

it("a setup that keeps failing stops after three machines and says so", async () => {
  const f = await homeFixture();
  f.api.onExec(({ machine, cmd }) => {
    if (cmd.includes("setsid nohup")) { machine.files.set(INSTABOX_SETUP_STATUS, Buffer.from("1\n")); return { exitCode: 0, stdout: "launched\n" }; }
    return null;
  });
  const { c } = ordered(f);
  await f.settle(c, x => x.status === "error", 40);
  expect(creates(f)).toBe(3);
  expect(c.managed!.retired).toHaveLength(2);
});

it("a plan cancelled mid-setup carries on with the setup once it is paid again, package and all", async () => {
  const f = await homeFixture();
  const { c, sub } = ordered(f);
  c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c).toMatchObject({ status: "provisioning", setupStep: "storage" });
  end(f, sub);
  await f.settle(c, x => x.status === "stopped" && f.api.machines.get(x.serverId!)?.state === "suspended", 10);
  expect(c.setupStep).toBe("storage");
  renew(f, sub);
  await f.settle(c, x => x.status === "running", 20);
  expect(c.managed!.installed).toBe(SHA);
  expect(creates(f)).toBe(1);
  expect(f.audit.entries(c.id).map(e => e.action)).toContain("setup_resumed");
});

it("a plan cancelled before its machine was made gets a machine once it is paid again", async () => {
  const f = await homeFixture();
  const { c, sub } = ordered(f);
  end(f, sub);
  c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c).toMatchObject({ status: "stopped", setupStep: "reserving", serverId: null });
  renew(f, sub);
  await f.settle(c, x => x.status === "running", 20);
  expect(creates(f)).toBe(1);
});

it("a home cut off mid-setup is never woken for a final backup and is deleted once retention ends", async () => {
  const f = await homeFixture();
  const { c, sub } = ordered(f);
  c.nextAttemptAt = 0; await f.service.reconcile();
  end(f, sub);
  for (let day = 0; day < 40 && c.status !== "destroyed"; day++) { f.advance(DAY_MS); c.nextAttemptAt = 0; await f.service.reconcile(); }
  const actions = f.audit.entries(c.id).map(e => e.action);
  expect(c.status).toBe("destroyed");
  expect(actions).not.toContain("wake");
  expect(actions).not.toContain("backup_refused");
  expect(f.api.deletes()).toHaveLength(1);
});

it("a home whose final backup cannot succeed is woken for it a few times, ever less often, then archived as a snapshot", async () => {
  const f = await homeFixture({ settings: { maxBackupBytes: 10 } });
  const { c, sub } = await f.paid();
  end(f, sub);
  for (let n = 0; n < 6 * 24 * 3; n++) { f.advance(10 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  const wakes = f.audit.entries(c.id).filter(e => e.action === "wake" && e.reason === "final_backup").length;
  expect(wakes).toBe(3);
  expect(c.managed!.backupProblem).toBe("too_large");
  expect(c.managed!.archive).toMatchObject({ serverId: null });
  expect(f.api.snapshots.has(c.managed!.archive!.snapshotId)).toBe(true);
  expect(c.serverId).toBeNull();
  expect(f.api.machines.size).toBe(0);
  expect(c.status).toBe("stopped");
  // a backup stopped part way leaves nothing on disk
  expect(f.backups.list(c.id)).toEqual([]);
});

it("a provider outage of two hours during a first setup is waited out, never a failed cloud", async () => {
  const f = await homeFixture();
  f.api.failNext(10_000);
  const { c } = ordered(f);
  for (let n = 0; n < 24; n++) { f.advance(5 * 60_000); await f.service.reconcile(); }
  expect(c).toMatchObject({ status: "provisioning", error: null });
  f.api.failNext(0);
  for (let n = 0; n < 12 && c.status !== "running"; n++) { f.advance(5 * 60_000); await f.service.reconcile(); }
  expect(c).toMatchObject({ status: "running", error: null, attempts: 0 });
});

it("a first setup in error pauses its machines, and is tried again later unless its script failed every time", async () => {
  for (const scriptBroken of [true, false]) {
    const f = await homeFixture();
    f.api.onExec(({ machine, cmd }) => {
      if (scriptBroken && cmd.includes("setsid nohup")) { machine.files.set(INSTABOX_SETUP_STATUS, Buffer.from("1\n")); return { exitCode: 0, stdout: "launched\n" }; }
      return null;
    });
    if (!scriptBroken) f.home.healthy.mockResolvedValue(false);
    const { c } = ordered(f);
    for (let n = 0; n < 40 && c.status !== "error"; n++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
    if (!scriptBroken) for (let n = 0; n < 30 && c.status !== "error"; n++) { f.advance(10 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
    expect(c.status).toBe("error");
    c.nextAttemptAt = 0; await f.service.reconcile();
    expect([...f.api.machines.values()].every(m => m.state === "suspended")).toBe(true);
    f.home.healthy.mockResolvedValue(true);
    for (let n = 0; n < 6 * 8 && c.status !== "running"; n++) { f.advance(10 * 60_000); await f.service.reconcile(); }
    expect(c.status).toBe(scriptBroken ? "error" : "running");
  }
});

/** a first setup whose home never answers its health check, left until it lands in its error state */
async function inSetupError(f: Fixture) {
  f.home.healthy.mockResolvedValue(false);
  const { c, sub } = ordered(f);
  for (let n = 0; n < 40 && c.status !== "error"; n++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
  for (let n = 0; n < 30 && c.status !== "error"; n++) { f.advance(10 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status).toBe("error");
  c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.managed!.setupErrorAt).not.toBeNull();
  return { c, sub };
}

it("the operator's retry runs a setup in error on the next pass, not hours later, and is audited once however often it is asked", async () => {
  const f = await homeFixture();
  const { c } = await inSetupError(f);
  f.home.healthy.mockResolvedValue(true);
  // without the retry, the next pass leaves it waiting for its scheduled try
  f.advance(60_000); c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.status).toBe("error");
  expect(f.service.retrySetup!(c.id, "admin_panel")).toEqual({ queued: true, already: false });
  expect(f.service.retrySetup!(c.id, "admin_panel")).toEqual({ queued: true, already: true });
  // the retry's own pass picks it up: no clock moved, no due time reset by hand
  await f.service.reconcile();
  expect(c.status).toBe("provisioning");
  await f.settle(c, x => x.status === "running", 20);
  expect(c).toMatchObject({ error: null, setupStep: null });
  expect(c.managed!.setupRetryAskedAt).toBeNull();
  const asked = f.audit.entries(c.id).filter(e => e.action === "setup_retry_asked");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ actor: "operator", reason: "admin_panel" });
  expect(f.audit.entries(c.id).find(e => e.action === "setup_resumed")).toMatchObject({ actor: "operator", reason: "retry_asked" });
  // a running cloud has nothing to retry
  expect(f.service.retrySetup!(c.id, "admin_panel")).toEqual({ refused: "not_in_setup_error" });
});

it("the operator's retry is refused where the scheduled one would not run: suspended, no plan, its script failed every time, a step running", async () => {
  const f = await homeFixture();
  const { c, sub } = await inSetupError(f);
  await f.service.suspend(c.id, "abuse");
  expect(f.service.retrySetup!(c.id, "admin_panel")).toEqual({ refused: "not_in_setup_error" });
  // a suspended cloud that still reads as in error (its suspension recorded, not yet applied) is refused for the suspension
  Object.assign(c, { status: "error" });
  expect(f.service.retrySetup!(c.id, "admin_panel")).toEqual({ refused: "suspended" });
  Object.assign(c, { suspended: null });
  end(f, sub);
  expect(f.service.retrySetup!(c.id, "admin_panel")).toEqual({ refused: "no_plan" });
  renew(f, sub);
  c.managed!.setupFailures = 3;
  expect(f.service.retrySetup!(c.id, "admin_panel")).toEqual({ refused: "setup_script_failed" });
  c.managed!.setupFailures = 0;
  // while a step of the cloud runs, nothing is changed
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const machine = f.provider.machine.bind(f.provider);
  const spy = vi.spyOn(f.provider, "machine").mockImplementation(async id => { await held; return machine(id); });
  c.nextAttemptAt = 0;
  const pass = f.service.reconcile();
  for (let n = 0; n < 50 && !spy.mock.calls.length; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(spy).toHaveBeenCalled();
  expect(f.service.retrySetup!(c.id, "admin_panel")).toEqual({ refused: "busy" });
  expect(c.managed!.setupRetryAskedAt ?? null).toBeNull();
  release(); await pass; spy.mockRestore();
  expect(f.audit.entries(c.id).map(e => e.action)).not.toContain("setup_retry_asked");
  expect(f.service.retrySetup!(c.id, "admin_panel")).toEqual({ queued: true, already: false });
});
