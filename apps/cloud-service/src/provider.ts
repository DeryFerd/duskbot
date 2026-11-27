import type { DashboardLink } from "../../dashboard/server/clouds/bootstrap.ts";
import { RetryableCloudError } from "../../dashboard/server/clouds/http.ts";
import type { CloudProvider, CreateServerInput, ProviderServer } from "../../dashboard/server/clouds/types.ts";
import type { ReleaseKey } from "./release-signing.ts";

export type MachineState = "creating" | "starting" | "running" | "stopping" | "stopped" | "error";
export interface MachineRecord {
  id: string;
  state: MachineState;
  cloudId: string | null;
  scope: string | null;
  type: string | null;
  stoppedAt: number | null;
  setup: "pending" | "running" | "done" | "failed" | null;
  createdAt: number | null;
}
export interface MachineCommandResult { ok: boolean; exitCode: number | null; stdout: string }
export interface MachineDeletion { id: string; status: "pending" | "processing" | "blocked" | "completed" }
export interface MachineCreateInput extends CreateServerInput {
  files?: Array<{ path: string; content: string }>;
  ttlSeconds: number | null;
  attempt?: number;
  /** boot from this provider snapshot (a home archived when its plan ended) instead of a fresh template: already set up */
  snapshotId?: string | null;
}
/** what the provider measured for one machine over a window */
export interface MachineUsage { from: number; to: number; runningSeconds: number; vcpuSeconds: number; memGiBSeconds: number; diskGiBSeconds: number; egressBytes: number }

export interface MachineProvider extends CloudProvider {
  readonly name: "managed";
  readonly scope: string;
  create(input: MachineCreateInput): Promise<ProviderServer>;
  machine(serverId: string): Promise<MachineRecord | null>;
  inventory(): Promise<MachineRecord[]>;
  listed(serverId: string): Promise<boolean>;
  origin(serverId: string): Promise<string>;
  run(serverId: string, command: string, timeoutSeconds?: number): Promise<MachineCommandResult>;
  lease(serverId: string, ttlSeconds: number | null): Promise<void>;
  latestSnapshot(serverId: string): Promise<{ id: string; at: number } | null>;
  snapshotTar(snapshotId: string, path: string): Promise<ReadableStream<Uint8Array>>;
  upload(serverId: string, path: string, body: Uint8Array): Promise<void>;
  deletion(operationId: string): Promise<MachineDeletion | null>;
  requestDelete(serverId: string): Promise<{ operationId: string | null; gone: boolean }>;
  limits(): Promise<{ nextStartCents: number | null } | null>;
  usage(serverId: string, from?: number): Promise<MachineUsage | null>;
  /** the machine stopped and saved whole (system disk and /data) as a provider snapshot named `name`; the same name again
   *  finds the one already made. null: the machine is gone */
  archive(serverId: string, name: string): Promise<{ id: string } | null>;
  /** a snapshot deleted; one already gone is no error */
  deleteSnapshot(snapshotId: string): Promise<void>;
}

export class ProviderError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(`The provider refused the request: ${code}.`); this.name = "ProviderError"; this.status = status; this.code = code; }
}
/** the provider refuses to start the machine for its own account's sake (an unpaid workspace, a suspended key), not the home's */
export class ProviderPausedError extends ProviderError {
  constructor(status: number, code: string) { super(status, code); this.name = "ProviderPausedError"; }
}
export class ProviderBusyError extends RetryableCloudError {
  constructor(code: string) { super(`The provider is busy: ${code}.`); this.name = "ProviderBusyError"; }
}
export interface ProviderLimitInfo { nextStartAt: number | null; window: "minute" | "hour" | "day" | null; cause: string | null; startLimit: boolean }
export class ProviderLimitError extends RetryableCloudError {
  readonly retryAfterMs: number | null;
  readonly info: ProviderLimitInfo;
  constructor(retryAfterMs: number | null, info?: ProviderLimitInfo) {
    super("The cloud provider asked us to slow down."); this.name = "ProviderLimitError"; this.retryAfterMs = retryAfterMs;
    this.info = info ?? { nextStartAt: null, window: null, cause: null, startLimit: false };
  }
}

export interface HomeBootInput { cloudId: string; adminOrigin: string; secret: string; dashboardUrl: string; link: DashboardLink; team?: { id: string; name: string } }
export interface HomeClaimInput { cloudId: string; claim: string; redeem: string }
export interface HomeSetupOptions { releaseKeys: readonly ReleaseKey[]; requireSigned: boolean }
export type HomeBootContent = { v: 1; env: Record<string, string>; link: DashboardLink; machine: string }
export interface MachineImage {
  homeVolume: string;
  packagePath: string;
  restorePath: string;
  bootFile(input: HomeBootInput): { path: string; content: string };
  claimBootFile(input: HomeClaimInput): { path: string; content: string };
  bootContent(input: HomeBootInput): HomeBootContent;
  setupScript(options: HomeSetupOptions): string;
  installCommand(sha: string, url?: string, sig?: string, floor?: string | null): string;
  startCommand(origin: string, upstream?: string): string;
  restoreCommand: string;
  /** back to the app the last install replaced (prints "rolled back") */
  rollbackCommand: string;
  /** prints the bot computers' image state: ready, building, failed or none */
  desktopStatusCommand: string;
  /** moves the home's saved phone relay tunnel aside (prints "moved aside" or "none") */
  phoneRelayAsideCommand: string;
  /** brings docker and the docker gate back (prints ok, none, healed <what>... or down docker|gate); `refreshGate`
   *  also restarts a gate that answers but runs an older package's code, which cuts live bot computer sessions */
  computerCheckCommand(refreshGate: boolean): string;
  /** sets the machine's clock to `nowMs` when it is more than 30 s off (prints ok, set <offset seconds> or failed) */
  clockCheckCommand(nowMs: number): string;
}
