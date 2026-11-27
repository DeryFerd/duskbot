import { useEffect, useSyncExternalStore } from "react";
import { NOT_PAIRED, type MobileDeviceAdoptRequest, type MobilePushRegistration, type PushTestResponse } from "../../../shared/mobile-link";
import type { MobilePlatform } from "../platform";
import { createConnectionStore } from "./connections";
import { installId } from "./pair";

const pending = new WeakMap<MobilePlatform, { work: Promise<void>; prompt: boolean }>();

/** Whether the place this phone is on can send it notifications. A phone signed in with a plain link (an old
 * `duskbot pair` invite) is not one of the place's paired phones, so it never could: `not-paired` says so, `old-server`
 * when the place is too old to let the phone fix that itself. Null until known, and on a place that could not be asked. */
export type PushPairing = "paired" | "not-paired" | "old-server" | null;

let pairing: PushPairing = null;
let pairingFor: string | null = null;
const listeners = new Set<() => void>();
function setPairing(next: PushPairing, recordId: string | null) {
  if (pairing === next && pairingFor === recordId) return;
  pairing = next;
  pairingFor = recordId;
  for (const listener of listeners) listener();
}

/** false: the phone registered, but its place has no way to send it a push (no keys of its own, no push relay). */
let delivering: boolean | null = null;
const deliveringListeners = new Set<() => void>();
function setDelivering(next: boolean | null) {
  if (delivering === next) return;
  delivering = next;
  for (const listener of deliveringListeners) listener();
}
export function usePushDelivering(): boolean | null {
  return useSyncExternalStore((listener) => { deliveringListeners.add(listener); return () => deliveringListeners.delete(listener); }, () => delivering);
}

export function usePushPairing(platform: MobilePlatform): PushPairing {
  const value = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => pairing);
  useEffect(() => { if (platform.native && pairing === null) void ensurePairedPhone(platform); }, [platform]);
  return value;
}

const bodyOf = async (response: Response) => await response.json().catch(() => null) as { code?: unknown; device?: { id?: unknown; push?: unknown } } | null;

/** The phone's own device id at its place, made a paired phone first when it only signed in. Null when it is not one
 * (and could not become one) or the place did not answer. */
export async function ensurePairedPhone(platform: MobilePlatform, { adopt = true, again = false }: { adopt?: boolean; again?: boolean } = {}): Promise<string | null> {
  const store = createConnectionStore(platform);
  const active = await store.active();
  if (!active) { setPairing(null, null); return null; }
  const id = active.record.id;
  if (active.record.deviceId) { setPairing("paired", id); return active.record.deviceId; }
  // asked once on this place already: the answer holds until the person asks again (Pair this phone)
  if (!again && pairingFor === id && (pairing === "not-paired" || pairing === "old-server")) return null;
  try {
    const asked = await fetch("/api/mobile/device", { signal: AbortSignal.timeout(15_000) });
    const known = await bodyOf(asked);
    let deviceId = asked.ok && typeof known?.device?.id === "string" ? known.device.id : null;
    // a place too old to say why answers its plain 404, with no code
    if (!deviceId && !(asked.status === 404 && known?.code === NOT_PAIRED)) { setPairing(asked.status === 404 ? "old-server" : null, id); return null; }
    if (!deviceId && adopt) {
      const request: MobileDeviceAdoptRequest = { name: platform.deviceName(), platform: platform.kind === "web" ? "other" : platform.kind, app: platform.appVersion, install: await installId(platform) };
      const made = await fetch("/api/mobile/device", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(15_000) });
      const answer = await bodyOf(made);
      if (made.ok && typeof answer?.device?.id === "string") deviceId = answer.device.id;
      else { setPairing(made.status === 404 || made.status === 405 ? "old-server" : "not-paired", id); return null; }
    }
    if (!deviceId) { setPairing("not-paired", id); return null; }
    if ((await store.active())?.record.id === id) await store.setDevice(id, deviceId);
    setPairing("paired", id);
    return deviceId;
  } catch {
    setPairing(null, id);
    return null;
  }
}

/** a workspace drops a token APNs or FCM refused, so a saved registration is checked before it is trusted */
async function stillRegistered(service: MobilePushRegistration["service"]): Promise<boolean> {
  try {
    const response = await fetch("/api/mobile/device", { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); return true; }
    const answer = await response.json() as { device?: { push?: unknown }; delivering?: unknown };
    if (typeof answer.delivering === "boolean") setDelivering(answer.delivering);
    return answer.device?.push === service;
  } catch {
    return true;
  }
}

/** `prompt`: the system may ask the person now (they just did something a notification follows up on); without it a
 * phone that was never asked registers nothing, so the app never asks at launch. The system is never asked on a place
 * that cannot send this phone a push. */
export function registerPushForConnection(platform: MobilePlatform, { prompt = false, again = false }: { prompt?: boolean; again?: boolean } = {}): Promise<void> {
  const existing = pending.get(platform);
  if (existing) return existing.prompt || !prompt ? existing.work : existing.work.then(() => registerPushForConnection(platform, { prompt }));
  const work = (async () => {
    if (!platform.native || !platform.registerPush) return;
    const active = await createConnectionStore(platform).active();
    if (!active) return;
    if (!await ensurePairedPhone(platform)) return;
    const registration = await platform.registerPush({ prompt });
    if (!registration) return;
    const body: MobilePushRegistration = {
      service: registration.platform, token: registration.token,
      ...(registration.platform === "apns" ? { environment: import.meta.env.DEV ? "sandbox" : "production" } : {}),
    };
    const value = JSON.stringify(body);
    const key = `dusk.mobile.push.${active.record.id}`;
    if (!again && await platform.prefs.get(key) === value && await stillRegistered(body.service)) return;
    if ((await createConnectionStore(platform).active())?.record.id !== active.record.id) return;
    const response = await fetch("/api/mobile/push", { method: "PUT", headers: { "Content-Type": "application/json" }, body: value, signal: AbortSignal.timeout(15_000) });
    const answer = await response.json().catch(() => null) as { delivering?: unknown } | null;
    if (response.ok) {
      setDelivering(typeof answer?.delivering === "boolean" ? answer.delivering : null);
      await platform.prefs.set(key, value);
    }
  })().catch(() => {}).finally(() => pending.delete(platform));
  pending.set(platform, { work, prompt });
  return work;
}

export type PushTestResult = "sent" | "not-registered" | "not-paired" | "undeliverable" | "failed";

/** A test notification to this phone, end to end through the place and its push service. */
export async function sendTestPush(platform: MobilePlatform): Promise<PushTestResult> {
  if (!await ensurePairedPhone(platform)) return "not-paired";
  // a phone that allowed notifications but never sent its token: send it now, so the test means what it says
  await registerPushForConnection(platform);
  try {
    const response = await fetch("/api/mobile/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) { const answer = await bodyOf(response); return answer?.code === NOT_PAIRED ? "not-paired" : "failed"; }
    if (!response.ok) { await response.body?.cancel(); return "failed"; }
    const outcome = (await response.json() as PushTestResponse).results[0]?.outcome;
    if (outcome === "skipped") setDelivering(false);
    else if (outcome === "sent") setDelivering(true);
    return outcome === "sent" ? "sent" : outcome === "unregistered" || outcome === "gone" ? "not-registered" : outcome === "skipped" ? "undeliverable" : "failed";
  } catch {
    return "failed";
  }
}
