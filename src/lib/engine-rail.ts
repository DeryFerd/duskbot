import type { InstanceInfo } from "@/state/store";
import { phoneApp } from "./store-app";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Whether this screen runs on the machine its server does: a ChatGPT plan sign-in opens a browser there and waits for it
 * on that machine's loopback, so a phone, a desktop connected to a server or a page from another host never completes one. */
function onServerMachine(): boolean {
  if (phoneApp() || globalThis.window?.duskDesktop?.remoteClient?.active === true) return false;
  const host = globalThis.location?.hostname;
  return !host || LOOPBACK.has(host);
}

/** A ChatGPT plan account that is not signed in and cannot be signed in from here: offered nowhere, since it would only
 * refuse. Signed in, it works from anywhere and stays. */
export function signInRefusedHere(instance: Pick<InstanceInfo, "snapshot">, here = onServerMachine()): boolean {
  if (instance.snapshot.chatgptPlan !== true || instance.snapshot.authenticated === true) return false;
  return Boolean(instance.snapshot.authenticationUnavailableReason) || !here;
}

export function configuredModelInstances(instances: readonly InstanceInfo[], selectedInstanceId?: string): InstanceInfo[] {
  return instances.filter((instance) =>
    instance.instanceId === selectedInstanceId
      || (instance.snapshot.state === "available" && (instance.models.options.length > 0 || instance.snapshot.chatgptPlan === true)));
}

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

/** A signed-in engine whose list it never gave is worth asking: a signed-out one would only refuse. */
export function modelsAwaitEngine(instance: Pick<InstanceInfo, "modelsUnconfirmed" | "snapshot"> | undefined): boolean {
  return instance?.modelsUnconfirmed === true
    && instance.snapshot.state === "available"
    && instance.snapshot.authenticated !== false;
}

export type SignInFamily = "claude" | "openai";

export function signInFamily(instance: { driverKind: string; access?: InstanceInfo["access"] } | undefined): SignInFamily | undefined {
  if (!instance || instance.access === "api") return undefined;
  if (instance.driverKind === "claudeAgent") return "claude";
  if (instance.driverKind === "codex") return "openai";
  return undefined;
}

export const SIGN_IN_FAMILY_LABEL: Record<SignInFamily, string> = { claude: "Claude", openai: "OpenAI" };

export function isClaudeAccount(instance: { driverKind: string; access?: InstanceInfo["access"] } | undefined): boolean {
  return signInFamily(instance) === "claude";
}

export function splitEngineRail<T>(instances: readonly T[]): {
  subscription: T[];
  api: T[];
  custom: T[];
} {
  const subscription: T[] = [];
  const api: T[] = [];
  const custom: T[] = [];
  for (const instance of instances) {
    const access = (instance as { access?: InstanceInfo["access"] }).access;
    if (access === "custom") custom.push(instance);
    else if (access === "api") api.push(instance);
    else subscription.push(instance);
  }
  return { subscription, api, custom };
}
