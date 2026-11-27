// `duskbot push`: which phones can get notifications from this server, and `duskbot push test` sends each one a test
// notification and says what the push service answered, so a phone that never gets pushes is never a silent mystery.
import type { MobileDevice, PushTestResponse } from "../shared/mobile-link.ts";

type Loopback = (path: string, init?: { method?: string; body?: string; timeoutMs?: number }) => Promise<{ status: number; body: any }>;
type Io = { log(line: string): void; error(line: string): void };

const OUTCOME: Record<PushTestResponse["results"][number]["outcome"], string> = {
  sent: "sent: it should show on the phone in a few seconds",
  unregistered: "not registered: open the dusk bot app on this phone and allow notifications (Settings, Notifications)",
  gone: "the phone's push token is no longer valid: open the dusk bot app on it once to register again",
  skipped: "not sent: this server has no way to send to this phone (no push keys here, and DUSK_PUSH_RELAY is off or the relay has none for it); see docs/phone-push.md",
  failed: "failed: the push service did not take it; check this server can reach the push relay, then try again",
};

export async function runPush(action: "status" | "test", call: Loopback, io: Io): Promise<number> {
  const devices = await call("/api/mobile/devices").catch(() => null);
  if (!devices) { io.error("No dusk bot server answered on this computer: start one with duskbot serve, or pass its --port."); return 1; }
  if (devices.status === 403) { io.error("This server did not let this computer list its phones. Run duskbot push on the server itself."); return 1; }
  if (devices.status !== 200) { io.error(`The server did not list its phones (${devices.status}).`); return 1; }
  const phones = (devices.body?.devices ?? []) as MobileDevice[];
  if (!phones.length) {
    io.log("No paired phones. A phone signed in with a code from a browser is not a paired phone and gets no notifications.");
    io.log("Pair one with: duskbot pair --phone ios (or android)");
    return action === "test" ? 1 : 0;
  }
  if (action === "status") {
    const where = await call("/api/mobile/push", { timeoutMs: 8_000 }).catch(() => null);
    const route = where?.status === 200 ? where.body as { own: string[]; relay: string | null; relayServices: string[] | null } : null;
    // whether a push for this service can leave the server: its own keys, or a relay that has them (or did not answer)
    const leaves = (service: string) => !route || route.own.includes(service) || (route.relay !== null && (route.relayServices === null || route.relayServices.includes(service)));
    let stuck = false;
    for (const phone of phones) {
      const name = phone.push === "apns" ? "APNs" : "FCM";
      if (phone.push && !leaves(phone.push)) stuck = true;
      io.log(`${phone.name} (${phone.platform}): ${!phone.push ? "not registered for notifications" : leaves(phone.push) ? `registered for ${name}` : `registered for ${name}, but this server cannot send ${name} pushes`}`);
    }
    if (route) io.log(route.own.length ? `push keys on this server: ${route.own.join(", ")}` : route.relay ? `push relay: ${route.relay}${route.relayServices ? ` (delivers ${route.relayServices.join(", ") || "nothing"})` : " (did not answer just now)"}` : "push: off (DUSK_PUSH_RELAY=off and no keys on this server)");
    if (stuck) io.log("Fix: unset DUSK_PUSH_RELAY (or point it at a relay that has the keys), or give this server its own keys (docs/phone-push.md).");
    io.log("Send each phone a test notification with: duskbot push test");
    return stuck ? 1 : 0;
  }
  const answer = await call("/api/mobile/push/test", { method: "POST", body: "{}", timeoutMs: 30_000 }).catch(() => null);
  if (!answer || answer.status === 404) { io.error("This server is too old to send a test notification. Update it, then try again."); return 1; }
  if (answer.status !== 200) { io.error(`The server did not send the test (${typeof answer.body?.error === "string" ? answer.body.error : answer.status}).`); return 1; }
  const result = answer.body as PushTestResponse;
  for (const one of result.results) io.log(`${one.name} (${one.platform}): ${OUTCOME[one.outcome]}`);
  if (result.relay) io.log(`(pushes go through ${result.relay})`);
  return result.results.every((one) => one.outcome === "sent") ? 0 : 1;
}
