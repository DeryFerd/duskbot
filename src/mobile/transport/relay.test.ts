import { createPrivateKey, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelaySecrets, deviceChannelKey, unbase64 } from "./link-crypto";
import { frameGuard, noteRelayDate, open, openFrame, readFrameBatches, RelayGoneError, sealFrame, type RelayFrame } from "./relay";

const protocolPath = "../../../electron/vps-link-protocol.mjs";
const protocol = await import(protocolPath);
const key = randomBytes(32);
const channel = "abcdefghij";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("relay crypto compatibility", () => {
  it("opens node control and binary vectors and lets node open browser frames", async () => {
    const frame = { t: "req", r: "abcdefghijkl", method: "POST", path: "/api/files", end: false };
    const nodeFrame = protocol.sealFrame(key, channel, "to-vps", frame);
    expect(await openFrame(key, channel, "to-vps", nodeFrame, frameGuard())).toMatchObject(frame);
    const browserFrame = await sealFrame(key, channel, "to-vps", frame);
    expect(protocol.openFrame(key, channel, "to-vps", browserFrame, protocol.frameGuard())).toMatchObject(frame);
    const bytes = randomBytes(150_000);
    const nodeBytes = protocol.sealBytes(key, channel, "to-app", frame.r, bytes);
    const opened = await openFrame(key, channel, "to-app", nodeBytes, frameGuard());
    expect(opened?.t).toBe("bytes");
    expect(Buffer.from(opened!.b!)).toEqual(bytes);
    await expect(openFrame(key, "abcdefghik", "to-app", nodeBytes, frameGuard())).rejects.toThrow();
    await expect(openFrame(key, channel, "to-vps", nodeBytes, frameGuard())).rejects.toThrow();
  });

  it("matches the agent's X25519 and HKDF channel key", async () => {
    const phone = await createRelaySecrets();
    const agent = protocol.x25519Pair();
    const jwk = createPrivateKey({ key: Buffer.from(unbase64(phone.priv)), format: "der", type: "pkcs8" }).export({ format: "jwk" });
    expect(Buffer.from(await deviceChannelKey(phone.priv, agent.pub, channel))).toEqual(protocol.sealKeyOf(jwk.d, phone.pub, agent.pub, channel));
    expect(Buffer.from(await deviceChannelKey(phone.priv, agent.pub, channel))).toEqual(protocol.sealKeyOf(agent.priv, agent.pub, phone.pub, channel));
  });

  it("rejects replay, stale and future frames", async () => {
    const sealed = protocol.sealFrame(key, channel, "to-app", { t: "end", r: "abcdefghijkl" });
    const guard = frameGuard();
    expect(await openFrame(key, channel, "to-app", sealed, guard)).not.toBeNull();
    expect(await openFrame(key, channel, "to-app", sealed, guard)).toBeNull();
    expect(await openFrame(key, channel, "to-app", sealed, frameGuard(() => Date.now() + 310_000))).toBeNull();
    expect(await openFrame(key, channel, "to-app", sealed, frameGuard(() => Date.now() - 310_000))).toBeNull();
    expect(frameGuard()("iv", Number.NaN)).toBe(false);
  });

  it("a phone clock ten minutes slow still takes the server's frames once it has heard the relay's time", async () => {
    const sealed = protocol.sealFrame(key, channel, "to-app", { t: "end", r: "abcdefghijkl" });
    const truth = Date.now();
    try {
      vi.spyOn(Date, "now").mockReturnValue(truth - 10 * 60_000);
      expect(await openFrame(key, channel, "to-app", sealed, frameGuard())).toBeNull();
      noteRelayDate(new Date(truth).toUTCString());
      expect(await openFrame(key, channel, "to-app", sealed, frameGuard())).not.toBeNull();
      const back = await sealFrame(key, channel, "to-vps", { t: "end", r: "abcdefghijkl" });
      vi.restoreAllMocks();
      expect(protocol.openFrame(key, channel, "to-vps", back, protocol.frameGuard())).not.toBeNull();
    } finally {
      vi.restoreAllMocks();
      noteRelayDate(new Date().toUTCString());
    }
  });
});

describe("relay reader", () => {
  it("reads split ndjson including CRLF, empty batches and the final line", async () => {
    const bytes = new TextEncoder().encode('\n{"frames":["one"]}\r\n{"frames":[]}\n{"frames":["two","three"]}');
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    const received: string[][] = [];
    await readFrameBatches(new Response(stream), async (frames) => { received.push(frames); });
    expect(received).toEqual([["one"], [], ["two", "three"]]);
  });

  it("rejects malformed batches", async () => {
    await expect(readFrameBatches(new Response('{"frames":[3]}\n'), async () => {})).rejects.toThrow("invalid relay batch");
  });
});

function relayFixture() {
  let incoming: ReadableStreamDefaultController<Uint8Array>;
  const controls: RelayFrame[] = [];
  const posts: Array<{ epoch: string; seq: number }> = [];
  const bodies = new Map<string, Uint8Array[]>();
  const streams = new Set<string>();
  const guard = protocol.frameGuard();
  const emit = (frames: RelayFrame[]) => incoming.enqueue(new TextEncoder().encode(`${JSON.stringify({ frames: frames.map((frame) => protocol.sealFrame(key, channel, "to-app", frame)) })}\n`));
  const finish = (r: string) => {
    const body = Buffer.concat((bodies.get(r) ?? []).map((chunk) => Buffer.from(chunk)));
    emit([{ t: "head", r, status: 200, headers: { "content-type": "application/octet-stream" } }]);
    incoming.enqueue(new TextEncoder().encode(`${JSON.stringify({ frames: [protocol.sealBytes(key, channel, "to-app", r, body)] })}\n`));
    emit([{ t: "end", r }]);
  };
  const streamFetch = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      incoming = controller;
      init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    },
  })));
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
    const batch = JSON.parse(String(init?.body));
    posts.push({ epoch: batch.epoch, seq: batch.seq });
    for (const sealed of batch.frames) {
      const frame = protocol.openFrame(key, channel, "to-vps", sealed, guard) as RelayFrame;
      controls.push(frame);
      if (frame.t === "req") {
        bodies.set(frame.r, []);
        if (frame.path === "/api/events") {
          streams.add(frame.r);
          emit([{ t: "head", r: frame.r, status: 200, headers: { "content-type": "text/event-stream" } }, { t: "data", r: frame.r, d: Buffer.from("data: hello\n\n").toString("base64") }]);
        } else if (frame.end) finish(frame.r);
      } else if (frame.t === "body") {
        if (frame.d) bodies.get(frame.r)!.push(unbase64(frame.d));
        if (frame.end) finish(frame.r);
      }
    }
    return new Response('{"ordered":true}');
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("window", { fetch: fetcher, CapacitorWebFetch: streamFetch });
  return { fetcher, streamFetch, controls, posts, streams, emit, dropPoll: () => incoming.error(new TypeError("network changed")) };
}

describe("relay channel", () => {
  it("streams SSE while uploading binary chunks with ordered posts", async () => {
    const fixture = relayFixture();
    const client = open("https://relay.test", channel, "channel-secret", key);
    try {
      const events = await client.request("GET", "/api/events", { Authorization: "Bearer session-secret" });
      expect(events.headers.get("content-type")).toBe("text/event-stream");
      const reader = events.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hello\n\n");
      const bytes = randomBytes(300_000);
      const response = await client.request("POST", "/api/files", { "Content-Type": "application/octet-stream" }, bytes);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      expect(fixture.controls.filter((frame) => frame.t === "body")).toHaveLength(3);
      expect(fixture.posts.map((batch) => batch.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(new Set(fixture.posts.map((batch) => batch.epoch)).size).toBe(1);
      expect(fixture.posts[0].epoch).toMatch(/^[a-z2-7]{12}$/);
      expect(fixture.streamFetch.mock.calls[0]).toEqual(["https://relay.test/v1/channels/abcdefghij/to-app?wait=25&stream=1", expect.objectContaining({ headers: { Authorization: "Bearer channel-secret" } })]);
      expect(fixture.fetcher.mock.calls.every(([url]) => String(url).endsWith("/to-vps") || String(url).endsWith("/node"))).toBe(true);
      await reader.cancel();
      await vi.waitFor(() => expect(fixture.controls.some((frame) => frame.t === "cancel")).toBe(true));
    } finally { client.close(); }
  });

  it("counts an upload's body as its chunks are posted", async () => {
    relayFixture();
    const client = open("https://relay.test", channel, "channel-secret", key);
    try {
      const sent: Array<[number, number]> = [];
      const bytes = randomBytes(300_000);
      const response = await client.request("POST", "/api/files", { "Content-Type": "application/pdf" }, bytes, undefined, (loaded, total) => sent.push([loaded, total]));
      expect(response.status).toBe(200);
      expect(sent).toEqual([[0, 300_000], [131_072, 300_000], [262_144, 300_000], [300_000, 300_000]]);
    } finally { client.close(); }
  });

  it("aborts an open response and closes pending channel reads", async () => {
    const fixture = relayFixture();
    const client = open("https://relay.test", channel, "channel-secret", key);
    const abort = new AbortController();
    const response = await client.request("GET", "/api/events", {}, null, abort.signal);
    abort.abort();
    await expect(response.text()).rejects.toThrow();
    await vi.waitFor(() => expect(fixture.controls.some((frame) => frame.t === "cancel")).toBe(true));
    client.close();
    expect(fixture.streamFetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(client.request("GET", "/api/bots")).rejects.toThrow("relay closed");
  });

  it("a lost poll fails what was waiting, and the next request starts a fresh link", async () => {
    const fixture = relayFixture();
    const client = open("https://relay.test", channel, "channel-secret", key);
    try {
      expect((await client.request("GET", "/api/bots")).status).toBe(200);
      const first = fixture.posts[0].epoch;
      const stream = await client.request("GET", "/api/events");
      fixture.dropPoll();
      await expect(stream.text()).rejects.toThrow();
      const again = await client.request("GET", "/api/bots");
      expect(again.status).toBe(200);
      const fresh = fixture.posts.at(-1)!;
      expect(fresh.epoch).not.toBe(first);
      expect(fresh.seq).toBe(0);
      expect(fixture.streamFetch).toHaveBeenCalledTimes(2);
    } finally { client.close(); }
  });

  it("a post the relay never took drops the link, and the next request posts on a new one", async () => {
    const fixture = relayFixture();
    const client = open("https://relay.test", channel, "channel-secret", key);
    try {
      fixture.fetcher.mockRejectedValueOnce(new TypeError("offline"));
      await expect(client.request("GET", "/api/bots")).rejects.toThrow();
      expect((await client.request("GET", "/api/bots")).status).toBe(200);
    } finally { client.close(); }
  });

  it("a channel the relay no longer has is gone for good, not a lost connection", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ error: "not found", code: "not_found" }), { status: 404 })));
    const client = open("https://relay.test", channel, "channel-secret", key);
    await expect(client.request("GET", "/api/bots")).rejects.toBeInstanceOf(RelayGoneError);
    await expect(client.request("GET", "/api/bots")).rejects.toBeInstanceOf(RelayGoneError);
    client.close();
  });

  it("fails requests when the relay refuses a poll", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })));
    const client = open("https://relay.test", channel, "channel-secret", key);
    await expect(client.request("GET", "/api/bots")).rejects.toThrow();
    client.close();
  });
});

describe("relay channel on a node that is not the server's home", () => {
  it("follows a 409 moved to the node the server lives on and sends the first request there, not only the next one", async () => {
    const fixture = relayFixture();
    const home = "https://home.relay.test";
    const moved = () => new Response(JSON.stringify({ code: "moved", node: "home", url: home, nodes: [{ url: "https://relay.test" }, { url: home }] }), { status: 409 });
    const through = fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation(async (input, init) => String(input).startsWith("https://relay.test/v1/channels/abcdefghij/to-vps") ? moved() : String(input).endsWith("/node") ? new Response("{}", { status: 404 }) : through(input, init));
    const origin = fixture.streamFetch.getMockImplementation()!;
    fixture.streamFetch.mockImplementation(async (input, init) => String(input).startsWith("https://relay.test/") ? moved() : origin(input, init));
    const client = open("https://relay.test", channel, "channel-secret", key);
    try {
      expect((await client.request("GET", "/api/bots")).status).toBe(200);
      const posted = fixture.fetcher.mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith("/to-vps"));
      expect(posted.at(-1)).toBe(`${home}/v1/channels/${channel}/to-vps`);
      expect(fixture.posts.map((one) => one.seq)).toEqual([0]);
      expect(String(fixture.streamFetch.mock.calls.at(-1)![0])).toBe(`${home}/v1/channels/${channel}/to-app?wait=25&stream=1`);
    } finally { client.close(); }
  });

  it("never follows a 409 to a node the relay did not list", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ code: "moved", url: "https://elsewhere.test", nodes: [{ url: "https://relay.test" }] }), { status: 409 })));
    const client = open("https://relay.test", channel, "channel-secret", key);
    await expect(client.request("GET", "/api/bots")).rejects.toThrow();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("https://elsewhere.test/v1/channels/abcdefghij/to-vps"))).toBe(false);
    client.close();
  });
});
