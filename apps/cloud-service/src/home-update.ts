// Updates a running managed home can't be broken by (shared/update-guard.ts). The newest release this service offers
// (DUSK_MANAGED_HOME_RELEASE_FILE, read again when it changes, else the package it was started with; a release file that
// lists cloud ids is offered to those clouds only, the rest keep the package the service started with) is installed only
// when its signature verifies, it is newer than what the home runs, at or above the signed floor and not blocked, and
// only while the home is idle: no turn, routine run, upload or backup. The home self-tests on the new version
// (server/update-state.ts); a failed self-test, or the next two runs failing in a row, rolls it back to the version
// before (`omb-home rollback`, never below the floor). The home itself tells its owner, in one line.
import { readFileSync, statSync } from "node:fs";
import { acceptPolicy, forgive, freshUpdateRecord, idleForUpdate, refusal, review, rolledBack, sawRun, selfTested, settle, startTrial, TRIAL_MS, type Release, type UpdatePolicy, type UpdateRecord, type Verdict } from "../../../shared/update-guard.ts";
import { RetryableCloudError } from "../../dashboard/server/clouds/http.ts";
import type { HomeClient, StoredCloud } from "../../dashboard/server/clouds/types.ts";
import type { Audit } from "./audit.ts";
import { COMPUTER_CHECK_MS, type ComputerHealthChecks } from "./computer-health.ts";
import type { MachineImage, MachineProvider } from "./provider.ts";
import { verifyRelease, type ReleaseKey } from "./release-signing.ts";

/** a home package on offer: its signature names its version; an unsigned one (loopback and the e2e harness only) may say it */
export interface HomeRelease { sha256: string; url?: string; file?: string; signature?: string; version?: string; clouds?: readonly string[] }
/** `forgiven`: rollbacks (version@at) already cleared from failed_here as the computer's, never twice */
export interface HomeUpdateState { guard: UpdateRecord; refused: string | null; stuck: boolean; retryAt: number | null; forgiven?: string[] }

/** known open risk: a home on these versions exits at every start once phone-relay.json holds a tunnel (its bundled link
 *  agent runs as a command), so it gets no link grant and its saved tunnel is moved aside before it starts */
export const RELAY_EXITS_ON: readonly string[] = ["0.2.26"];
/** the version a managed home runs, as its update record knows it; null before the record exists */
export const homeVersion = (c: StoredCloud): string | null => c.managed?.update?.guard.current?.version ?? null;
export const relayExits = (version: string | null) => version !== null && RELAY_EXITS_ON.includes(version);
/** a link grant goes only to a home whose version is known and loads its phone relay safely */
export const takesLinkGrant = (c: StoredCloud) => { const version = homeVersion(c); return version !== null && !relayExits(version); };

/** how long a new version gets to answer and pass its self-test */
export const SELF_TEST_WAIT_MS = 5 * 60_000;
const INSTALL_RETRY_MS = 60 * 60_000;
/** an install restarts the home: never this close to a scheduled run, which the busy list read earlier in the pass
 *  cannot show yet once it starts */
export const DUE_RUN_GUARD_MS = 3 * 60_000;
/** Releases rolled back on runs_failed in this window, while docker gates were down on homes set up before 2026-11-19:
 *  their runs failed for want of their computer, not for the release. A cloud whose last rollback is in the window gets
 *  these versions back once, offered again once its computer answers. `to` runs past this fix's deploy: until then the
 *  old reconciler blamed releases the same way. */
export const MISBLAMED = { from: Date.UTC(2026, 10, 21), to: Date.UTC(2026, 11, 15), versions: ["0.2.26", "0.2.27"] } as const;
const MISBLAMED_KEY = "misblamed-2026-11";
const SHA256 = /^[a-f0-9]{64}$/;

/** DUSK_MANAGED_HOME_RELEASE_FILE: `{ sha256, signature, url | file, clouds? }`, read again whenever it changes; `clouds`
 * (cloud ids) limits the offer to those clouds, for a canary, and an empty or missing list offers it to every cloud */
export function createReleaseFile(file: string | null | undefined): () => HomeRelease | null {
  let held: { mtime: number; value: HomeRelease | null } | null = null;
  return () => {
    if (!file) return null;
    let mtime: number;
    try { mtime = statSync(file).mtimeMs; } catch { return held?.value ?? null; }
    if (held?.mtime !== mtime) {
      let value: HomeRelease | null = null;
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        if (typeof raw.sha256 === "string" && SHA256.test(raw.sha256) && (typeof raw.url === "string" || typeof raw.file === "string")) {
          value = { sha256: raw.sha256, ...(typeof raw.url === "string" ? { url: raw.url } : { file: raw.file as string }),
            ...(typeof raw.signature === "string" ? { signature: raw.signature } : {}), ...(typeof raw.version === "string" ? { version: raw.version } : {}),
            ...(Array.isArray(raw.clouds) && raw.clouds.length ? { clouds: raw.clouds.filter((id): id is string => typeof id === "string") } : {}) };
        }
      } catch { value = held?.value ?? null; }
      held = { mtime, value };
    }
    return held.value;
  };
}

export const offeredTo = (release: HomeRelease, cloudId: string) => !release.clouds?.length || release.clouds.includes(cloudId);

export interface HomeUpdateDeps {
  provider: MachineProvider;
  image: MachineImage;
  home: HomeClient;
  audit: Audit;
  releaseKeys: readonly ReleaseKey[];
  requireSigned: boolean;
  /** what this service offers now, newest first: the release file, then the package it started with */
  releases(): Array<HomeRelease | null>;
  policy(): UpdatePolicy | null;
  /** the bot computers' docker and gate (computer-health.ts): checked before an install, after a restart, and when a
   *  trial's run fails */
  computer?: ComputerHealthChecks;
  now(): number;
  save(cloud: StoredCloud): void;
}

/** what the reconciler knows of the home this pass */
/** `nextDueAt`: the home's next scheduled run, as it last said */
export interface HomeUpdateContext { origin: string; upstream: string; secret: string; busy: readonly string[] | null; nextDueAt?: number | null }

export function createHomeUpdates(deps: HomeUpdateDeps) {
  const log = (c: StoredCloud, action: string, reason: string, detail?: Record<string, string | number | boolean | null>, actor: "reconciler" | "operator" = "reconciler") =>
    deps.audit.record({ cloudId: c.id, action, actor, reason, serverId: c.serverId, ...(detail ? { detail } : {}) });

  function versionOf(pkg: HomeRelease): string | null {
    if (pkg.signature) {
      try { return verifyRelease(pkg.signature, { kind: "home-package", sha256: pkg.sha256 }, deps.releaseKeys).version; } catch { return null; }
    }
    return deps.requireSigned ? null : pkg.version ?? null;
  }
  function known(sha256: string | null): Release | null {
    if (!sha256) return null;
    const pkg = deps.releases().find(p => p?.sha256 === sha256);
    const version = pkg ? versionOf(pkg) : null;
    return version ? { version, sha256 } : null;
  }
  function stateOf(c: StoredCloud): HomeUpdateState {
    const b = c.managed!;
    const u = (b.update ??= { guard: freshUpdateRecord(known(b.installed)), refused: null, stuck: false, retryAt: null });
    // a fresh machine (a recovery, a rebuild) runs whatever its setup installed: that is the version now, with nothing before it
    if (!u.guard.trial && b.installed && u.guard.current?.sha256 !== b.installed) { u.guard.current = known(b.installed); u.guard.previous = null; }
    return u;
  }

  /** `computerDownAt`: the rollback is for a computer found down right after the install; when the version before does
   *  not bring it back either, the release did not cause it and is offered again once the computer answers */
  async function rollback(c: StoredCloud, x: HomeUpdateContext, u: HomeUpdateState, verdict: Extract<Verdict, { action: "rollback" }>, computerDownAt?: number) {
    const from = u.guard.current?.version ?? null;
    const done = await deps.provider.run(c.serverId!, deps.image.rollbackCommand, 300);
    if (!done.ok || !done.stdout.includes("rolled back")) {
      log(c, "update_rollback_failed", verdict.reason, { from, to: verdict.to.version });
      console.warn(`managed: cloud ${c.id}: the rollback from ${from} to ${verdict.to.version} failed; it is tried again`);
      throw new RetryableCloudError("Cloud update rollback failed.");
    }
    const { failedRuns } = rolledBack(u.guard, verdict.to, verdict.reason, deps.now());
    c.managed!.installed = verdict.to.sha256; u.stuck = false;
    log(c, "update_rolled_back", verdict.reason, { from, to: verdict.to.version, rerunFree: failedRuns.length });
    console.log(`managed: cloud ${c.id}: the update to ${from} was rolled back to ${verdict.to.version} (${verdict.reason})`);
    deps.save(c);
    if (relayExits(verdict.to.version)) await asideRelay(c);
    const started = await deps.provider.run(c.serverId!, deps.image.startCommand(x.origin, x.upstream), 120);
    if (!started.ok) throw new RetryableCloudError("Cloud home did not start after a rollback.");
    const after = await deps.computer?.check(c, "after_rollback", computerDownAt === undefined ? deps.now() : Math.max(deps.now(), computerDownAt + 1), true);
    if (computerDownAt !== undefined && after?.health === "down" && from && forgive(u.guard, from)) {
      u.refused = null;
      log(c, "update_forgiven", "computer_down", { versions: from });
      deps.save(c);
    }
  }

  /** a runs_failed rollback the computer caused gives its version back once: inside MISBLAMED, or when a check from the
   *  trial's day to just after the rollback found docker or the gate not answering. It installs again only once the
   *  computer answers (the check before an install) */
  function forgiveMisblamed(c: StoredCloud, u: HomeUpdateState) {
    const last = u.guard.last;
    if (last?.kind !== "rolled_back" || last.reason !== "runs_failed" || u.guard.trial) return;
    const inWindow = last.at >= MISBLAMED.from && last.at < MISBLAMED.to && !u.forgiven?.includes(MISBLAMED_KEY);
    const key = inWindow ? MISBLAMED_KEY : `${last.version}@${last.at}`;
    if (u.forgiven?.includes(key)) return;
    const computerDown = (c.managed?.computer?.history ?? []).some(([at, infra]) => infra && at >= last.at - TRIAL_MS && at <= last.at + COMPUTER_CHECK_MS);
    if (!inWindow && !computerDown) return;
    const versions = inWindow ? [...new Set<string>([last.version, ...MISBLAMED.versions])] : [last.version];
    const cleared = versions.filter(v => forgive(u.guard, v));
    u.forgiven = [...(u.forgiven ?? []), key].slice(-20);
    if (cleared.length) { u.refused = null; log(c, "update_forgiven", inWindow ? "computer_down_2026_11" : "computer_down", { versions: cleared.join(":") }); }
    deps.save(c);
  }

  async function asideRelay(c: StoredCloud) {
    const done = await deps.provider.run(c.serverId!, deps.image.phoneRelayAsideCommand, 60);
    if (!done.ok) console.warn(`managed: cloud ${c.id}: its saved phone relay tunnel could not be moved aside before it starts`);
    else if (done.stdout.includes("moved aside")) log(c, "phone_relay_aside", "relay_exits", { version: homeVersion(c) });
  }

  /** the trial's verdict this pass: the home's own report of its self-test and runs; null while its self-test runs */
  async function judge(c: StoredCloud, x: HomeUpdateContext, u: HomeUpdateState): Promise<Verdict | null> {
    const trial = u.guard.trial!, now = deps.now();
    const report = await deps.home.update?.(x.upstream, x.secret).catch(() => null) ?? null;
    let verdict: Verdict = { action: "wait" };
    if (trial.selfTest === "pending") {
      const elsewhere = report !== null && report.version !== null && report.version !== trial.to.version;
      if (report?.selfTest === "failed" || elsewhere || (report?.selfTest !== "passed" && now - trial.at > SELF_TEST_WAIT_MS)) verdict = selfTested(u.guard, false, now);
      else if (report?.selfTest === "passed") verdict = selfTested(u.guard, true, now);
      else return null;
    }
    const fresh = (report?.runs ?? []).filter(run => run.at >= trial.at && !trial.runs.some(r => r.id === run.id) && !trial.excused?.includes(run.id));
    const failed = fresh.filter(run => !run.ok && !run.infra);
    // a failed run is the release's only when the computer answered at the first check after it
    if (failed.length && deps.computer) await deps.computer.check(c, "trial_run_failed", Math.max(...failed.map(run => run.at)));
    let excused = 0;
    for (const run of fresh) {
      if (verdict.action !== "wait") break;
      const infra = !run.ok && (run.infra === true || deps.computer?.downAfter(c, run.at) === true);
      if (infra) excused += 1;
      verdict = sawRun(u.guard, { id: run.id, ok: run.ok, infra }, now);
    }
    if (excused) log(c, "update_runs_excused", "computer_unreachable", { version: trial.to.version, runs: excused });
    return verdict.action === "wait" ? review(u.guard, now) : verdict;
  }

  /**
   * One update step for a running home, after its power read. True when the step used this pass (an install, a rollback,
   * a self-test still running): the reconciler stops there, and never sleeps a home in the middle of one.
   */
  async function step(c: StoredCloud, x: HomeUpdateContext): Promise<boolean> {
    if (!c.serverId || !c.managed) return false;
    const u = stateOf(c), now = deps.now();
    const policy = deps.policy();
    if (policy && acceptPolicy(u.guard, policy)) { log(c, "update_policy", "signed", { serial: policy.serial, floor: policy.floor, blocked: policy.blocked.length }); deps.save(c); }
    forgiveMisblamed(c, u);
    const verdict = u.guard.trial ? await judge(c, x, u) : review(u.guard, now);
    if (verdict === null) { deps.save(c); return true; }
    if (verdict.action === "settle") { const to = u.guard.trial!.to.version; settle(u.guard, now); log(c, "update_settled", "trial_passed", { version: to }); deps.save(c); return false; }
    if (verdict.action === "stuck") {
      if (!u.stuck) { u.stuck = true; log(c, "update_stuck", verdict.reason, { version: u.guard.current?.version ?? null }); console.warn(`managed: ALERT cloud ${c.id}: ${u.guard.current?.version} should be rolled back (${verdict.reason}) but nothing allowed is left to go back to`); deps.save(c); }
      return false;
    }
    if (verdict.action === "rollback") {
      // a failed self-test follows an install at an idle moment; anything later waits for one, so no run is cut short
      if (verdict.reason !== "self_test" && !(x.busy && idleForUpdate(x.busy))) return false;
      await rollback(c, x, u, verdict);
      return true;
    }
    if (u.guard.trial || !x.busy) return false;
    const pkg = deps.releases().find((p): p is HomeRelease => p !== null && offeredTo(p, c.id));
    if (!pkg || pkg.sha256 === c.managed.installed) return false;
    const version = versionOf(pkg), offer = version ? { version, sha256: pkg.sha256 } : null;
    const why = offer ? refusal(u.guard, offer) : "invalid";
    if (why) {
      if (u.refused !== `${pkg.sha256}:${why}`) { u.refused = `${pkg.sha256}:${why}`; log(c, "update_refused", why, { version }); deps.save(c); }
      return false;
    }
    // staged: it waits for an idle moment
    if (!idleForUpdate(x.busy) || (u.retryAt !== null && u.retryAt > now)) return false;
    if (x.nextDueAt != null && Math.abs(x.nextDueAt - now) < DUE_RUN_GUARD_MS) return false;
    // a home whose computer is down is repaired first: a trial there would blame the release for it
    if (deps.computer?.downRecently(c)) return false;
    const before = await deps.computer?.check(c, "before_update", now - 2 * 60_000, true);
    if (before?.health === "down") return false;
    if (pkg.file) await deps.provider.upload(c.serverId, deps.image.packagePath, readFileSync(pkg.file));
    const floor = pkg.signature ? u.guard.policy.floor : null;
    const done = await deps.provider.run(c.serverId, deps.image.installCommand(pkg.sha256, pkg.url, pkg.signature, floor), 600);
    if (!done.ok || !done.stdout.includes("installed")) {
      u.retryAt = now + INSTALL_RETRY_MS;
      log(c, "update_install_failed", done.stdout.includes("older package") ? "older" : done.stdout.includes("below floor") ? "below_floor" : "install", { version: offer!.version });
      deps.save(c);
      return true;
    }
    const from = u.guard.current?.version ?? null;
    startTrial(u.guard, offer!, now); u.retryAt = null; u.refused = null; c.managed.installed = pkg.sha256;
    log(c, "update_applied", "idle", { from, to: offer!.version });
    deps.save(c);
    const started = await deps.provider.run(c.serverId, deps.image.startCommand(x.origin, x.upstream), 120);
    if (!started.ok) {
      const failed = selfTested(u.guard, false, deps.now());
      if (failed.action === "rollback") await rollback(c, x, u, failed);
      return true;
    }
    // an omb-home from before 2026-11-19 leaves the gate on the older package's code
    const after = await deps.computer?.check(c, "after_update", Math.max(deps.now(), (before?.at ?? 0) + 1), true);
    // the package carries the gate: a computer that answered before the install and stays down after it, its gate and
    // docker restarted, was taken down by the release. Its trial runs would all be excused as the computer's
    if (after?.health === "down" && (before?.health === "ok" || before?.health === "healed")) {
      log(c, "update_computer_down", "after_update", { version: offer!.version, what: after.down });
      const failed = selfTested(u.guard, false, deps.now());
      if (failed.action === "rollback") await rollback(c, x, u, failed, after.at);
    }
    return true;
  }

  /** the operator ends a version's trial early (a test cloud whose routines don't run): only once its self-test passed,
   *  so a newer release may install at the next idle moment; audited with the operator's reason */
  function endTrial(c: StoredCloud, reason: string): { ended: string } | { refused: "no_trial" | "self_test_pending" } {
    const u = c.managed?.update;
    if (!u?.guard.trial) return { refused: "no_trial" };
    if (u.guard.trial.selfTest !== "passed") return { refused: "self_test_pending" };
    const version = u.guard.trial.to.version;
    settle(u.guard, deps.now());
    log(c, "update_settled", "operator", { version, why: reason }, "operator");
    deps.save(c);
    return { ended: version };
  }
  return { step, endTrial, asideRelay, state: (c: StoredCloud) => c.managed?.update ?? null };
}
export type HomeUpdates = ReturnType<typeof createHomeUpdates>;
