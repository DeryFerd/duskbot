// An in-progress login belongs to the admin session that started it: never put its device code on global SSE.
import { BoxFenceError } from "./bot-box/plan.ts";
import type { ProviderAuthenticationOptions, ProviderAuthenticationStart, ProviderInstance } from "./contracts.ts";

type LoginInstance = Pick<ProviderInstance, "instanceId" | "startAuthentication" | "getAuthentication" | "completeAuthentication" | "cancelAuthentication" | "signOut">;
type Flow = {
  instance: LoginInstance;
  owner: string;
  flowId: string | null;
  expiresAt: number;
  busy: boolean;
  starting: boolean;
  revoked: boolean;
  /** Its own person stopped it before the provider gave a link: nothing about it is told. */
  abandoned?: boolean;
  /** Settles once the provider start under way has ended, so a start right after an abandoned one waits for it. */
  pending?: Promise<void>;
  /** Signed in already when this flow began: a signed-in status then proves nothing about this sign-in. */
  wasSignedIn: boolean;
  expiry?: ReturnType<typeof setTimeout>;
};

const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

export class ProviderAuthSessions {
  private readonly flows = new Map<string, Flow>();
  /** A sign-in to this AI finished: whatever waited on it being signed out may use it again. */
  private readonly signedIn: (instanceId: string) => void;
  /** How a sign-in went, for usage signals; `error` is read only to pick a reason code. */
  private readonly outcome: (instanceId: string, outcome: "started" | "succeeded" | "failed" | "expired" | "cancelled", error?: unknown) => void;
  private readonly told = new Set<string>();
  /** An instance and owner whose last flow the app stopped to try another way: the next start is the same attempt. */
  private readonly retrying = new Set<string>();
  /** Whether this AI reads as signed in right now, from its last status. */
  private readonly signedInNow: (instanceId: string) => boolean;

  constructor(options: { signedIn?: (instanceId: string) => void; outcome?: ProviderAuthSessions["outcome"]; signedInNow?: (instanceId: string) => boolean } = {}) {
    this.signedIn = options.signedIn ?? (() => {});
    this.outcome = options.outcome ?? (() => {});
    this.signedInNow = options.signedInNow ?? (() => false);
  }

  /** An AI's status now reads signed in. A browser sign-in that comes back to the engine's own loopback ends there, and
   * the app then watches the AI's status instead of this flow's: without this its success would never be told. */
  sawSignedIn(instanceId: string): void {
    const flow = this.flows.get(instanceId);
    if (!flow?.flowId || flow.revoked || flow.wasSignedIn) return;
    this.tell(instanceId, flow.flowId, "succeeded");
  }

  /** A flow nobody finished or cancelled (the window closed, the person chose a key instead) is told as expired once it
   * runs out; one that ended first was told then, and this is a no-op. */
  private expireLater(flow: Flow): void {
    if (flow.expiry) clearTimeout(flow.expiry);
    const flowId = flow.flowId;
    if (!flowId) return;
    flow.expiry = setTimeout(() => {
      flow.expiry = undefined;
      if (flow.flowId === flowId) this.tell(flow.instance.instanceId, flowId, "expired", "sign-in timed out");
    }, Math.max(0, Math.min(flow.expiresAt - Date.now(), 2 ** 31 - 1)));
    flow.expiry.unref?.();
  }

  /** Each flow's end is told once, however often its status is read. */
  private tell(instanceId: string, flowId: string | null, outcome: Parameters<ProviderAuthSessions["outcome"]>[1], error?: unknown): void {
    const key = `${instanceId}|${flowId ?? ""}|${outcome === "started" ? "start" : "end"}`;
    if (flowId && this.told.has(key)) return;
    if (flowId) { this.told.add(key); if (this.told.size > 500) this.told.delete(this.told.values().next().value!); }
    try { this.outcome(instanceId, outcome, error); } catch {}
  }

  /** A sign-in under way, until it expires: one whose provider call never returns stops counting then too. */
  get active(): boolean {
    return [...this.flows.values()].some((flow) => flow.expiresAt > Date.now() && (flow.busy || !flow.revoked));
  }

  async start(instance: LoginInstance, owner: string, options?: ProviderAuthenticationOptions): Promise<ProviderAuthenticationStart> {
    if (!instance.startAuthentication) throw failure("Account setup is unavailable for this provider.", 404);
    const existing = this.flows.get(instance.instanceId);
    if (existing?.abandoned && existing.owner === owner && existing.pending) {
      await existing.pending;
      return this.start(instance, owner, options);
    }
    if (existing && (existing.busy || (existing.owner !== owner && existing.expiresAt > Date.now()))) {
      throw failure("A sign-in is already in progress. Finish or cancel it in the browser that started it, or wait for it to expire.", 409);
    }
    const resuming = existing && existing.owner === owner && existing.expiresAt > Date.now() && !existing.revoked;
    const flow: Flow = resuming ? existing : { instance, owner, flowId: null, expiresAt: Date.now() + 15 * 60_000, busy: false, starting: false, revoked: false,
      wasSignedIn: (() => { try { return this.signedInNow(instance.instanceId); } catch { return false; } })() };
    flow.busy = true;
    flow.starting = true;
    let settle!: () => void;
    flow.pending = new Promise<void>((resolve) => { settle = resolve; });
    this.flows.set(instance.instanceId, flow);
    try {
      const result = await instance.startAuthentication(options);
      if (flow.revoked || this.flows.get(instance.instanceId) !== flow) {
        await instance.cancelAuthentication?.();
        throw failure("Sign-in cancelled because the session or provider changed.", 409);
      }
      flow.flowId = result.flowId;
      const expiry = Date.parse(result.expiresAt ?? "");
      if (Number.isFinite(expiry)) flow.expiresAt = expiry;
      const retryKey = `${instance.instanceId}|${owner}`;
      if (!resuming && !this.retrying.delete(retryKey)) this.tell(instance.instanceId, result.flowId, "started");
      if (result.phase === "waiting") this.expireLater(flow);
      if (result.phase === "succeeded") {
        this.flows.delete(instance.instanceId);
        this.signedIn(instance.instanceId);
        this.tell(instance.instanceId, result.flowId, "succeeded");
      }
      return result;
    } catch (error) {
      if ((!resuming || flow.revoked) && this.flows.get(instance.instanceId) === flow) this.flows.delete(instance.instanceId);
      if (!flow.abandoned) this.tell(instance.instanceId, null, "failed", error);
      if (error instanceof BoxFenceError) {
        console.warn(`provider sign-in: the bot box refused ${error.path} for ${instance.instanceId}`);
        throw failure("This AI's sign-in could not start on this server: its bot box would not let the AI use its own folder. Update dusk bot on this server, then try again.", 500);
      }
      throw error;
    } finally {
      flow.busy = false;
      flow.starting = false;
      flow.pending = undefined;
      settle();
    }
  }

  private owned(instanceId: string, owner: string, flowId: string): Flow {
    const flow = this.flows.get(instanceId);
    if (!flowId || !flow || flow.revoked || flow.owner !== owner || flow.flowId !== flowId) {
      throw failure("This sign-in is no longer available in this browser. Start a new sign-in.", 404);
    }
    if (flow.busy) throw failure("The sign-in is still being updated. Try again shortly.", 409);
    return flow;
  }

  async status(instanceId: string, owner: string, flowId: string) {
    const flow = this.owned(instanceId, owner, flowId);
    if (!flow.instance.getAuthentication) throw failure("Sign-in status is unavailable for this provider.", 404);
    const status = await flow.instance.getAuthentication(flowId);
    if (flow.revoked) throw failure("This sign-in session ended.", 404);
    if (status.phase !== "waiting") flow.expiresAt = 0;
    if (status.phase === "succeeded") this.signedIn(instanceId);
    if (status.phase !== "waiting") this.tell(instanceId, flowId, status.phase, (status as { error?: unknown }).error ?? status.message);
    return status;
  }

  async complete(instanceId: string, owner: string, flowId: string, callbackUrl: string) {
    const flow = this.owned(instanceId, owner, flowId);
    if (!flow.instance.completeAuthentication) throw failure("This provider does not use a callback URL.", 400);
    flow.busy = true;
    try {
      let done: void | { location?: string };
      try { done = await flow.instance.completeAuthentication(flowId, callbackUrl); } catch (error) {
        // a paste turned away before use (400) leaves the sign-in open for another
        if ((error as { status?: number }).status !== 400) this.tell(instanceId, flowId, "failed", error);
        throw error;
      }
      if (this.flows.get(instanceId) === flow) this.flows.delete(instanceId);
      this.signedIn(instanceId);
      this.tell(instanceId, flowId, "succeeded");
      return done?.location ? { location: done.location } : {};
    } finally { flow.busy = false; }
  }

  /** `why`: the person stopped it, the app lost track of it (a dropped connection, a computer that slept), its wait ran
   * out, or the app stopped it to try another way at once (that next start is the same attempt). */
  async cancel(instanceId: string, owner: string, flowId: string, why: "person" | "lost" | "timeout" | "retry" = "person") {
    const flow = this.owned(instanceId, owner, flowId);
    flow.busy = true;
    try { await flow.instance.cancelAuthentication?.(); }
    finally {
      flow.busy = false;
      flow.expiresAt = 0;
      if (why === "retry") {
        this.told.add(`${instanceId}|${flowId}|end`);
        this.retrying.add(`${instanceId}|${owner}`);
      } else if (why === "lost") this.tell(instanceId, flowId, "failed", "network: the app lost the connection to this sign-in");
      else if (why === "timeout") this.tell(instanceId, flowId, "expired", "sign-in timed out");
      else this.tell(instanceId, flowId, "cancelled");
    }
  }

  /** The person stopped a sign-in before its link reached the app: the provider's start is stopped when it returns,
   * and one that already returned is cancelled. */
  async abandon(instanceId: string, owner: string): Promise<void> {
    const flow = this.flows.get(instanceId);
    if (!flow || flow.owner !== owner || flow.revoked) return;
    if (flow.starting) {
      flow.revoked = true;
      flow.abandoned = true;
      return;
    }
    if (flow.flowId && flow.expiresAt > Date.now() && !flow.busy) await this.cancel(instanceId, owner, flow.flowId);
  }

  /** Never pulls a login another admin is completing, and no one may start one while the credential is being removed. */
  async signOut(instance: LoginInstance, owner: string): Promise<void> {
    if (!instance.signOut) throw failure("Sign-out is unavailable for this provider.", 404);
    const existing = this.flows.get(instance.instanceId);
    if (existing && (existing.busy || (existing.owner !== owner && existing.expiresAt > Date.now() && !existing.revoked))) {
      throw failure("A sign-in is in progress. Finish or cancel it in the browser that started it, or wait for it to expire.", 409);
    }
    const flow: Flow = { instance, owner, flowId: null, expiresAt: Date.now() + 60_000, busy: true, starting: false, revoked: false, wasSignedIn: true };
    this.flows.set(instance.instanceId, flow);
    try {
      if (existing) await existing.instance.cancelAuthentication?.();
      await instance.signOut();
    } finally {
      if (this.flows.get(instance.instanceId) === flow) this.flows.delete(instance.instanceId);
    }
  }

  revokeOwner(owner: string): void {
    for (const [id, flow] of this.flows) {
      if (flow.owner !== owner) continue;
      flow.revoked = true;
      // A pending start owns its eventual cancellation: keep the reservation so another browser cannot race into this auth home.
      if (flow.starting) continue;
      flow.busy = true;
      void Promise.resolve().then(() => flow.instance.cancelAuthentication?.()).catch(() => {}).finally(() => {
        if (this.flows.get(id) === flow) this.flows.delete(id);
      });
    }
  }

  clear(): void {
    for (const flow of this.flows.values()) flow.revoked = true;
    this.flows.clear();
  }

  clearInstance(instanceId: string): void {
    const flow = this.flows.get(instanceId);
    if (flow) flow.revoked = true;
    this.flows.delete(instanceId);
  }
}
