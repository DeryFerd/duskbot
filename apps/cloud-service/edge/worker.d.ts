export declare const HOLD_MS: number;
export declare const MISSING_TTL_S: number;
export declare const MISSES_PER_MINUTE: number;
export declare function openingWake(request: Request, url: URL): boolean;
export declare function wakeReason(request: Request, url: URL): "webhook" | "client" | null;
export declare function routeFor(label: string, env: EdgeEnv, ctx: { waitUntil(p: Promise<unknown>): void }, options?: { fresh?: boolean }): Promise<{ upstream: string; awake: boolean; wakeable: boolean } | null>;
export declare function deliveryId(request: Request, url: URL, body: ArrayBuffer | undefined): Promise<string>;
export { HookQueue, QUEUE_LIMITS } from "./hook-queue.js";
export declare const ROBOTS: string;

/** the Durable Object namespace binding as the Worker uses it */
export interface HookQueueNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export interface EdgeEnv {
  ROUTE_URL: string;
  EDGE_TOKEN: string;
  PUBLIC_DOMAIN: string;
  HOOK_QUEUE?: HookQueueNamespace;
  HOOK_SEAL_KEY?: string;
}
declare const worker: { fetch(request: Request, env: EdgeEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> };
export default worker;
