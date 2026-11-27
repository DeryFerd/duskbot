// A phone signed in with a plain code is not a paired phone, so it cannot register for push, and that must be said.
// These cover the three ways out: a pairing at an address the server checks, a signed-in phone making itself a
// paired phone, and a test push that says what the push service did.
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MobilePairingResponse, PushTestResponse } from "../../shared/mobile-link.ts";
import type { RequestAuth } from "../request-auth.ts";
import { SessionRegistry, type SessionRecord } from "../sessions.ts";
import { createMobileLink } from "./link.ts";
import type { PushMessage, PushOutcome, PushTarget } from "./push.ts";

const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const json = (res: ServerResponse, status: number, body: unknown) => { (res as unknown as { _out: unknown })._out = { status, body }; };
const readBody = async (req: IncomingMessage) => (req as IncomingMessage & { body: unknown }).body;

let dir: string, sessions: SessionRegistry, sent: Array<{ target: PushTarget; message: PushMessage }>, outcome: PushOutcome, descriptors: Record<string, unknown>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dusk-mobile-push-"));
  sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  sent = [];
  outcome = "sent";
  descriptors = {};
});
afterEach(() => { sessions.close(); rmSync(dir, { recursive: true, force: true }); });

function link(extra: Partial<Parameters<typeof createMobileLink>[0]> = {}) {
  return createMobileLink({
    dataDir: dir, sessions,
    workspace: () => ({ name: "Ram's server", environmentId: "env-1", kind: "server" }),
    publicOrigin: () => null,
    refusal: () => null,
    lookupRelay: null,
    fetch: (async (url: string) => {
      const origin = new URL(url).origin;
      if (url.endsWith("/.well-known/duskbot/environment") && origin in descriptors) return Response.json(descriptors[origin]);
      throw new Error(`offline: ${url}`);
    }) as typeof fetch,
    push: {
      configured: [], delivers: () => true,
      send: async (target, message) => { sent.push({ target, message }); return outcome; },
      status: async () => ({ own: [], relay: "https://relay.test", relayServices: ["apns", "fcm"] }),
    },
    log: () => {},
    ...extra,
  });
}

async function call(mobile: ReturnType<typeof link>, auth: RequestAuth, method: string, path: string, body: unknown = {}) {
  const res = { setHeader: () => {}, once: () => res } as unknown as ServerResponse;
  const req = { headers: { "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" }, body } as unknown as IncomingMessage;
  await mobile.route({ req, res, path, method, auth, json, readBody });
  return (res as unknown as { _out: { status: number; body: any } })._out;
}

/** what the old `duskbot pair` invite gave a phone: a bearer session, not a paired phone */
function signedIn(fields: Partial<SessionRecord> = {}, via: "bearer" | "cookie" = "bearer"): RequestAuth {
  const opened = sessions.openPairing({ scopes: ["admin", "client"], label: "iPhone" });
  const exchanged = sessions.exchange({ code: opened.credential, label: "iPhone", source: "203.0.113.9" });
  if (!exchanged.ok) throw new Error("exchange failed");
  const session = { ...exchanged.session, ...fields } as SessionRecord;
  return { kind: "session", session, via, scopes: session.scopes };
}

describe("pairing at an address the server does not know itself", () => {
  it("puts a --public-url origin in the code once it answers as this workspace", async () => {
    descriptors["https://dusk.example"] = { environmentId: "env-1" };
    const answer = await call(link(), owner, "POST", "/api/mobile/pairing", { label: "iPhone", origin: "https://dusk.example/" });
    expect(answer.status).toBe(200);
    expect((answer.body as MobilePairingResponse).payload.via).toEqual([{ kind: "https", url: "https://dusk.example" }]);
  });

  it.each([
    ["another workspace", "https://other.example", { environmentId: "env-2" }],
    ["nothing answering", "https://down.example", undefined],
    ["plain http", "http://dusk.example", { environmentId: "env-1" }],
    ["a path", "https://dusk.example/bots", { environmentId: "env-1" }],
  ])("refuses an origin that is %s, so no grant goes there", async (_, origin, descriptor) => {
    if (descriptor) descriptors[new URL(origin).origin] = descriptor;
    const answer = await call(link(), owner, "POST", "/api/mobile/pairing", { origin });
    expect(answer).toMatchObject({ status: 409, body: { code: "origin_unverified" } });
  });

  it("still says unreachable with no address at all", async () => {
    expect(await call(link(), owner, "POST", "/api/mobile/pairing", {})).toMatchObject({ status: 409, body: { code: "unreachable" } });
  });
});

describe("a signed-in phone that is not a paired phone", () => {
  it("is told so with a code, then makes itself a paired phone that registers and gets a test push", async () => {
    const mobile = link();
    const phone = signedIn();
    expect(await call(mobile, phone, "GET", "/api/mobile/device")).toMatchObject({ status: 404, body: { code: "not_paired" } });
    expect(await call(mobile, phone, "PUT", "/api/mobile/push", { service: "apns", token: "a".repeat(64) })).toMatchObject({ status: 403, body: { code: "not_paired" } });

    const adopted = await call(mobile, phone, "POST", "/api/mobile/device", { name: "Ram's iPhone", platform: "ios", app: "1.2.12", install: "install-0123456789abcdef" });
    expect(adopted).toMatchObject({ status: 200, body: { device: { name: "Ram's iPhone", platform: "ios", push: null } } });
    // asking again is the same phone
    expect((await call(mobile, phone, "POST", "/api/mobile/device", {})).body.device.id).toBe(adopted.body.device.id);
    expect(await call(mobile, phone, "PUT", "/api/mobile/push", { service: "apns", token: "a".repeat(64), environment: "production" })).toMatchObject({ status: 200, body: { ok: true, delivering: true } });

    const test = await call(mobile, phone, "POST", "/api/mobile/push/test");
    expect(test.status).toBe(200);
    expect((test.body as PushTestResponse).results).toEqual([{ id: adopted.body.device.id, name: "Ram's iPhone", platform: "ios", service: "apns", outcome: "sent" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toEqual({ service: "apns", token: "a".repeat(64), environment: "production" });
    expect(sent[0]!.message).toMatchObject({ kind: "test", botName: "dusk bot" });
    // the owner sees it among the phones
    expect((await call(mobile, owner, "GET", "/api/mobile/devices")).body.devices).toHaveLength(1);
  });

  it.each([
    ["a browser's cookie", {}, "cookie"],
    ["a person's email sign-in", { email: "friend@example.test" }, "bearer"],
    ["a team member's", { membershipAuthority: "team" }, "bearer"],
  ] as const)("never adopts %s", async (_, fields, via) => {
    const answer = await call(link(), signedIn(fields as Partial<SessionRecord>, via), "POST", "/api/mobile/device", { platform: "ios" });
    expect(answer).toMatchObject({ status: 403, body: { code: "not_adoptable" } });
  });
});

describe("push test", () => {
  it("tells the owner which phones have no registration and drops a dead token", async () => {
    const mobile = link();
    const [one, two] = [signedIn(), signedIn()];
    await call(mobile, one, "POST", "/api/mobile/device", { name: "Pixel", platform: "android" });
    await call(mobile, two, "POST", "/api/mobile/device", { name: "iPad", platform: "ios" });
    await call(mobile, one, "PUT", "/api/mobile/push", { service: "fcm", token: "f".repeat(80) });
    outcome = "gone";
    const answer = (await call(mobile, owner, "POST", "/api/mobile/push/test")).body as PushTestResponse;
    expect(answer.relay).toBe("https://relay.test");
    expect(answer.results.map((r) => [r.name, r.outcome])).toEqual([["Pixel", "gone"], ["iPad", "unregistered"]]);
    expect((await call(mobile, one, "GET", "/api/mobile/device")).body.device.push).toBeNull();
  });

  // QA A5: the server said delivering:false and nothing read it
  it("tells a registered phone whether its pushes can leave this server at all", async () => {
    const mobile = link({ push: { configured: [], delivers: () => false, send: async () => "skipped" } });
    const phone = signedIn();
    await call(mobile, phone, "POST", "/api/mobile/device", { platform: "ios" });
    expect(await call(mobile, phone, "PUT", "/api/mobile/push", { service: "apns", token: "a".repeat(64) })).toMatchObject({ status: 200, body: { delivering: false } });
    expect(await call(mobile, phone, "GET", "/api/mobile/device")).toMatchObject({ status: 200, body: { delivering: false } });
    expect((await call(mobile, phone, "POST", "/api/mobile/push/test")).body.results[0].outcome).toBe("skipped");
  });

  it("is refused to a session that is not a phone and not an admin", async () => {
    const client = signedIn({ scopes: ["client"] });
    expect(await call(link(), { ...client, scopes: ["client"] } as RequestAuth, "POST", "/api/mobile/push/test")).toMatchObject({ status: 404, body: { code: "not_paired" } });
  });
});
