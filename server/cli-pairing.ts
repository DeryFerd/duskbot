// What `duskbot serve` and `duskbot pair` print for a pairing code. A browser on this computer is no longer the
// owner just by being here, so it signs in once with the link printed for it.
import qrcode from "qrcode-terminal";

import { universalPairLink, type MobilePairingResponse } from "../shared/mobile-link.ts";

/** A sign-in code for a web browser: `url` opens the web app's /pair, `localUrl` signs in a browser on this computer.
 * It never pairs the phone app (that is `duskbot pair --phone`), so it says so: a phone signed in this way gets no
 * notifications. */
export function pairingBlock(input: {
  code: string;
  url: string | null;
  localUrl?: string | null;
  expiresAt: number;
  hint?: string | null;
}): string {
  const lines = [`pairing code:  ${input.code}`, `expires:       ${new Date(input.expiresAt).toLocaleTimeString()} (single use)`];
  if (input.localUrl) lines.push(`this computer: ${input.localUrl}`);
  if (!input.url) {
    lines.push(`open:          /pair on the address you use for this server, and type the code`);
    if (input.hint) lines.push(`               (${input.hint})`);
  } else {
    lines.push(`web browser:   ${input.url}`, "", qrToString(input.url), "");
    lines.push("That QR signs in a web browser.");
  }
  lines.push(PHONE_APP_HINT);
  return lines.join("\n");
}

export const PHONE_APP_HINT = "For the phone app, with notifications, run: duskbot pair --phone ios (or android)";

/** The dusk bot phone app's own pairing: a QR its camera scan opens, and the code it can type instead. It reaches this
 * server over the link relay, so it needs no public address. */
export function phoneAppBlock(pairing: MobilePairingResponse, phone?: "ios" | "android"): string {
  const how = phone === "android" ? "Scan this in the dusk bot app (Add a computer or server), or with your camera:" : "Scan this with your phone's camera, or in the dusk bot app:";
  const link = universalPairLink(pairing.link, pairing.code);
  const lines = [how, "", qrToString(link), "", `or open this link on the phone:  ${link}`];
  if (pairing.code) lines.push(`or type this code in the app:  ${pairing.code}`);
  lines.push(`expires:       ${new Date(pairing.expiresAt).toLocaleTimeString()} (single use)`, "Keep this code private.");
  return lines.join("\n");
}

type LoopbackPost = (path: string, init: { method: string; body?: string; timeoutMs: number }) => Promise<{ status: number; body: any }>;

export type PhonePairingResult =
  | { ok: true; block: string; via: string[] }
  | { ok: false; reason: "no_address" | "origin_unverified" | "refused" | "old_server" | "failed"; message: string };

/** What to do when a phone cannot pair here, said plainly: without a paired phone there are no notifications. */
export const PHONE_NEEDS_ADDRESS = [
  "The phone app cannot pair with this server yet, so it could not get notifications.",
  "A phone needs to reach the server over HTTPS. Give it an address, then run duskbot pair --phone again:",
  "  duskbot serve --public-url https://your.host   (your own proxy or Cloudflare tunnel)",
  "  duskbot serve --tailscale                       (or --tunnel, or --domain your.host)",
  "  or pass the address once: duskbot pair --phone ios --public-url https://your.host",
].join("\n");

/** A real phone pairing (POST /api/mobile/pairing): the phone app redeems it as a paired phone, which is what lets it
 * register for push. `origin` is an https address the server may not know itself; the server checks it serves this
 * workspace before putting it in the code. */
export async function phonePairing(post: LoopbackPost, input: { label?: string; client?: boolean; origin?: string; phone?: "ios" | "android" } = {}): Promise<PhonePairingResult> {
  const request = { ...(input.label ? { label: input.label } : {}), ...(input.client ? { scopes: ["client"] } : {}), ...(input.origin ? { origin: input.origin } : {}) };
  let got: { status: number; body: any };
  try { got = await post("/api/mobile/pairing", { method: "POST", body: JSON.stringify(request), timeoutMs: 30_000 }); }
  catch (error) { return { ok: false, reason: "failed", message: `The server did not answer the pairing request (${error instanceof Error ? error.message : String(error)}).` }; }
  const { status, body } = got;
  if (status === 200 && typeof body?.link === "string" && Array.isArray(body?.payload?.via) && body.payload.via.length) {
    const via = (body.payload.via as { kind?: string; url?: string; base?: string }[]).map((route) => route.kind === "https" ? `https ${route.url}` : route.kind === "relay" ? `relay ${route.base}` : String(route.kind));
    return { ok: true, block: phoneAppBlock(body as MobilePairingResponse, input.phone), via };
  }
  if (status === 404 || status === 405) return { ok: false, reason: "old_server", message: "This server is too old to pair the phone app. Update it (duskbot update, or pull the new Docker image), then run duskbot pair --phone again." };
  if (body?.code === "origin_unverified") return { ok: false, reason: "origin_unverified", message: `${input.origin} does not answer as this server over HTTPS, so a phone could not use it. Check the proxy or tunnel points at this server, then try again.` };
  if (body?.code === "unreachable") return { ok: false, reason: "no_address", message: PHONE_NEEDS_ADDRESS };
  return { ok: false, reason: status === 403 ? "refused" : "failed", message: typeof body?.error === "string" ? body.error : `The server refused to pair a phone (${status}).` };
}

/** One line on whether a push can leave this server for that phone: its own keys, or the push relay's. */
export async function pushReadiness(post: LoopbackPost, phone?: "ios" | "android"): Promise<string | null> {
  const got = await post("/api/mobile/push", { method: "GET", timeoutMs: 8_000 }).catch(() => null);
  if (!got || got.status !== 200) return null;
  const { own, relay, relayServices } = got.body as { own?: string[]; relay?: string | null; relayServices?: string[] | null };
  const services = phone === "ios" ? ["apns"] : phone === "android" ? ["fcm"] : ["apns", "fcm"];
  const name = (service: string) => service === "apns" ? "iPhone (APNs)" : "Android (FCM)";
  const lines = services.map((service) => {
    if (own?.includes(service)) return `notifications:  ${name(service)} through this server's own keys`;
    if (!relay) return `notifications:  off for ${name(service)}: DUSK_PUSH_RELAY is off and this server has no keys (docs/phone-push.md)`;
    if (relayServices === null || relayServices === undefined) return `notifications:  ${name(service)} through ${relay} (could not reach it just now)`;
    return relayServices.includes(service) ? `notifications:  ${name(service)} through ${relay}` : `notifications:  ${relay} cannot send to ${name(service)} (docs/phone-push.md)`;
  });
  return [...lines, "check later:    duskbot push test"].join("\n");
}

/** The guided start's one sign-in, for the browser it opens on this computer. */
export function browserSignInLines(localUrl: string, code: string, expiresAt: number): string {
  return [
    "Sign in from a browser on this computer with this link (single use, until",
    `${new Date(expiresAt).toLocaleTimeString()}): ${localUrl}`,
    `or type the code ${code} on the sign-in page. Later: duskbot pair`,
  ].join("\n");
}

export function qrToString(text: string): string {
  let out = "";
  qrcode.generate(text, { small: true }, (rendered: string) => {
    out = rendered;
  });
  return out;
}
