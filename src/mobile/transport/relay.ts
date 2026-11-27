import { base64url, seal, subtle, unbase64, unsealRaw, utf8 } from "./link-crypto";

export type RelayFrame = {
  t: string;
  r: string;
  ts?: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  status?: number;
  end?: boolean;
  d?: string;
  b?: Uint8Array;
  message?: string;
  /** on a "head" frame: when the server's link process started, in the link service's time */
  since?: number;
  /** a control op and its answer (ctl frames), and a reply's byte count (marks and ends) */
  op?: string;
  data?: unknown;
  ok?: boolean;
  error?: string;
  n?: number;
};

export type FrameGuard = (iv: string, ts: unknown) => boolean;
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31]).join("");
const SKEW_MS = 5 * 60_000;
/** a relay run with nothing in flight this long stops reading: with the direct path up the relay only carries signaling */
export const RELAY_IDLE_MS = 60_000;
/** frames are stamped and checked in the link service's time (its Date header), the same way the app and the server
 * do, so a phone whose clock is minutes off still talks; under RELAY_CLOCK_SLACK_MS the phone keeps its own clock */
const RELAY_CLOCK_SLACK_MS = 3000;
let relayOffsetMs = 0;
export function noteRelayDate(value: string | null, now = Date.now()): void {
  const at = Date.parse(value ?? "");
  if (!Number.isFinite(at)) return;
  const offset = at + 500 - now;
  relayOffsetMs = Math.abs(offset) < RELAY_CLOCK_SLACK_MS ? 0 : offset;
}
export const relayNow = (): number => Date.now() + relayOffsetMs;

export function frameGuard(now = relayNow): FrameGuard {
  const seen = new Map<string, number>();
  return (iv, ts) => {
    const time = now();
    if (typeof ts !== "number" || !Number.isFinite(ts) || Math.abs(time - ts) > SKEW_MS || seen.has(iv)) return false;
    seen.set(iv, time);
    for (const [key, at] of seen) { if (time - at <= 2 * SKEW_MS) break; seen.delete(key); }
    return true;
  };
}

export function sealFrame(key: Uint8Array, channel: string, direction: "to-vps" | "to-app", frame: RelayFrame): Promise<string> {
  return seal(key, `${channel}|${direction}`, utf8(JSON.stringify({ ...frame, ts: relayNow() })));
}

/** `sealed` is base64url (relay) or bytes (the direct path); the guard keys on the iv either way, so one guard covers both */
export async function openFrame(key: Uint8Array, channel: string, direction: "to-vps" | "to-app", sealed: string | Uint8Array, guard: FrameGuard): Promise<RelayFrame | null> {
  const raw = typeof sealed === "string" ? unbase64(sealed) : sealed;
  const plain = await unsealRaw(key, `${channel}|${direction}`, raw);
  const frame: RelayFrame = plain[0] === 1 && plain.length >= 21
    ? { t: "bytes", r: new TextDecoder().decode(plain.slice(1, 13)), ts: new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getFloat64(13), b: plain.slice(21) }
    : JSON.parse(new TextDecoder().decode(plain));
  return guard(typeof sealed === "string" ? sealed.slice(0, 16) : base64url(sealed.subarray(0, 12)), frame.ts) ? frame : null;
}

export async function readFrameBatches(response: Response, receive: (frames: string[]) => Promise<void>): Promise<void> {
  if (!response.body) throw new Error("missing relay stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const line = async (value: string) => {
    if (!value.trim()) return;
    const batch: unknown = JSON.parse(value);
    if (!batch || typeof batch !== "object" || !("frames" in batch) || !Array.isArray(batch.frames) || !batch.frames.every((frame) => typeof frame === "string")) throw new Error("invalid relay batch");
    await receive(batch.frames);
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      let at: number;
      while ((at = text.indexOf("\n")) >= 0) { await line(text.slice(0, at)); text = text.slice(at + 1); }
      if (text.length > 24 * 1024 * 1024) throw new Error("relay batch too large");
      if (chunk.done) { await line(text); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** The relay no longer has this channel (the phone was removed, or the server left the relay): pairing again is the
 * only way back, where any other failure is a connection that may return. */
export class RelayGoneError extends Error {
  constructor() {
    super("relay channel gone");
    this.name = "RelayGoneError";
  }
}

export interface RelayChannel {
  request(method: string, path: string, headers?: HeadersInit, body?: Uint8Array | null, signal?: AbortSignal, onBodyProgress?: (sent: number, total: number) => void): Promise<Response>;
  close(): void;
  /** one sealed control op to the server's link agent and its answer (the relay's own channel only) */
  control?(op: string, data: unknown, signal?: AbortSignal): Promise<RelayFrame>;
}

/** One run of posts and polls. A failed post or poll ends it, and the next request starts another under a new epoch,
 * which the relay reads as the writer restarting. */
type Link = { abort: AbortController; epoch: string; seq: number; posts: Promise<void>; polling: boolean };
type Pending = { link: Link; at: number; head(frame: RelayFrame): void; data(bytes: Uint8Array): void; end(): void; fail(error: unknown): void; ctl?(frame: RelayFrame): void };

/** `guard`: the channel's replay guard, shared with its direct path (direct.ts) */
export function open(base: string, channel: string, token: string, key: Uint8Array, guard: FrameGuard = frameGuard()): RelayChannel {
  subtle();
  const root = new URL(base);
  if (!["http:", "https:"].includes(root.protocol) || root.username || root.password || root.pathname !== "/" || root.search || root.hash || !/^[a-z2-7]{10}$/.test(channel) || key.length !== 32) throw new Error("invalid relay route");
  // the link service may run on several nodes; the channel lives on its server's node. any node answers where that is
  // (GET /v1/channels/<id>/node), so a failed or unanswered request asks again and the next one goes there
  let node = root.origin, route = `${node}/v1/channels/${channel}`;
  let known: string[] = [], locating: Promise<void> | null = null, lastLocate = 0;
  const postFetch = fetch;
  const streamFetch = typeof window === "undefined" ? fetch : (window as Window & { CapacitorWebFetch?: typeof fetch }).CapacitorWebFetch ?? window.fetch;
  const pending = new Map<string, Pending>();
  let link: Link | null = null;
  let closed = false;
  let gone = false;
  let agentSince: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = () => {
    if (pending.size || !link) return;
    const on = link;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!pending.size && link === on) { link = null; on.abort.abort(); } }, RELAY_IDLE_MS);
  };

  const drop = (broken: Link, error: unknown = new Error("relay closed")) => {
    if (link === broken) link = null;
    broken.abort.abort();
    for (const request of pending.values()) if (request.link === broken) request.fail(error);
  };
  const close = () => {
    closed = true;
    clearTimeout(idleTimer);
    if (link) drop(link);
  };
  const originOf = (value: unknown) => { try { const url = new URL(String(value)); return ["http:", "https:"].includes(url.protocol) ? url.origin : null; } catch { return null; } };
  /** asks the node it was given, then nodes it heard of, where the channel lives; a 404 there means it is really gone */
  const relocate = () => {
    if (locating || closed || Date.now() - lastLocate < 10_000) return locating ?? Promise.resolve();
    lastLocate = Date.now();
    locating = (async () => {
      for (const at of new Set([root.origin, ...known])) {
        try {
          const response = await postFetch(`${at}/v1/channels/${channel}/node`, { headers: { Authorization: `Bearer ${token}` }, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8000) });
          if (response.status === 404 && at === root.origin) { gone = true; return; }
          if (!response.ok) continue;
          const body = await response.json() as { url?: string; nodes?: Array<{ url?: string }> };
          if ((body.nodes?.length ?? 0) < 2) return;
          known = (body.nodes ?? []).map((item) => originOf(item.url)).filter((url): url is string => !!url).slice(0, 16);
          const url = originOf(body.url);
          if (url && (url === root.origin || known.includes(url)) && url !== node) { node = url; route = `${node}/v1/channels/${channel}`; if (link) drop(link); }
          return;
        } catch { /* the next node */ }
      }
    })().finally(() => { locating = null; });
    return locating;
  };
  /** a node that is not the server's home refuses its channel's traffic with 409 and where it lives (code "moved"): the
   * phone goes there and sends again, so a first request is not lost to the node the pairing named. Only the node it was
   * given or one that node listed is followed. `used`: the route that was refused; another call may have moved already. */
  const follow = (text: string, used: string): boolean => {
    if (route !== used) return true;
    let body: { code?: unknown; url?: unknown; nodes?: unknown };
    try { body = JSON.parse(text); } catch { return false; }
    if (body?.code !== "moved") return false;
    const listed = (Array.isArray(body.nodes) ? body.nodes : []).map((item) => originOf((item as { url?: unknown } | null)?.url)).filter((url): url is string => !!url).slice(0, 16);
    const url = originOf(body.url);
    if (!url || url === node || (url !== root.origin && !listed.includes(url) && !known.includes(url))) return false;
    if (listed.length) known = listed;
    node = url; route = `${node}/v1/channels/${channel}`;
    return true;
  };
  /** the relay answers 404 for a channel it does not have, whatever the token; a node it moved to may not be the one asked */
  const refused = (status: number) => {
    void relocate();
    if (status !== 404) return new Error(`relay ${status}`);
    if (node !== root.origin) return new Error("relay moved");
    gone = true;
    return new RelayGoneError();
  };
  // learn the other nodes now, while the one it was given answers: after that node dies is too late to ask it
  void relocate();
  const post = (on: Link, frames: RelayFrame[]) => {
    const next = on.posts.then(async () => {
      if (on.abort.signal.aborted) throw new Error("relay closed");
      const sealed = await Promise.all(frames.map((frame) => sealFrame(key, channel, "to-vps", frame)));
      const body = JSON.stringify({ frames: sealed, epoch: on.epoch, seq: on.seq++ });
      const send = async () => {
        const used = route;
        const response = await postFetch(`${used}/to-vps`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body, credentials: "omit", redirect: "error",
          signal: AbortSignal.any([on.abort.signal, AbortSignal.timeout(15_000)]),
        });
        return { response, used, text: await response.text() };
      };
      let sent = await send();
      // dropping the link on a move would fail this very request, so it is kept: the post goes again to the node it lives on
      if (sent.response.status === 409 && follow(sent.text, sent.used)) sent = await send();
      noteRelayDate(sent.response.headers.get("date"));
      if (!sent.response.ok) throw refused(sent.response.status);
    });
    on.posts = next.catch((error) => { if (!(error instanceof RelayGoneError) && !on.abort.signal.aborted) void relocate(); drop(on, error instanceof RelayGoneError ? error : undefined); });
    return next;
  };
  const poll = async (on: Link) => {
    if (on.polling) return;
    on.polling = true;
    try {
      while (!on.abort.signal.aborted) {
        // a node that beats (x-link-beat) and then says nothing for two beats and a bit is on a dead connection (a network
        // switch leaves it silent, not closed): the read ends and the next one dials afresh
        const quiet = new AbortController();
        const used = route;
        const response = await streamFetch(`${used}/to-app?wait=25&stream=1`, {
          headers: { Authorization: `Bearer ${token}` }, credentials: "omit", redirect: "error",
          signal: AbortSignal.any([on.abort.signal, quiet.signal, AbortSignal.timeout(40_000)]),
        });
        if (response.status === 409) {
          if (follow(await response.text().catch(() => ""), used)) continue;
          throw refused(409);
        }
        if (!response.ok) { await response.body?.cancel(); throw refused(response.status); }
        noteRelayDate(response.headers.get("date"));
        const beatMs = Number(response.headers.get("x-link-beat")) * 1000;
        let heardAt = Date.now();
        const beat = beatMs > 0 ? setInterval(() => { if (Date.now() - heardAt > beatMs * 2 + 3000) quiet.abort(new Error("relay read went silent")); }, Math.min(1000, beatMs)) : null;
        try { await readFrameBatches(response, async (frames) => {
          heardAt = Date.now();
          for (const sealed of frames) {
            let frame: RelayFrame | null;
            try { frame = await openFrame(key, channel, "to-app", sealed, guard); } catch { continue; }
            if (!frame) continue;
            // the server's link process started again (its replies say since when): what went through the one before
            // (a live stream) is gone
            if (frame.t === "head" && typeof frame.since === "number") {
              if (agentSince !== null && frame.since > agentSince) for (const [id, one] of pending) if (id !== frame.r && one.at < frame.since - 1000) one.fail(new Error("relay restarted"));
              agentSince = Math.max(agentSince ?? 0, frame.since);
            }
            const request = pending.get(frame.r);
            if (!request) continue;
            if (frame.t === "head") request.head(frame);
            else if (frame.t === "data") request.data(unbase64(frame.d ?? ""));
            else if (frame.t === "bytes" && frame.b) request.data(frame.b);
            else if (frame.t === "end") request.end();
            else if (frame.t === "err") request.fail(new Error("relay request failed"));
            else if (frame.t === "ctl") request.ctl?.(frame);
          }
        }); } finally { if (beat) clearInterval(beat); }
      }
    } catch (error) { if (!(error instanceof RelayGoneError) && !on.abort.signal.aborted) void relocate(); drop(on, error instanceof RelayGoneError ? error : undefined); }
  };
  return {
    close,
    control(op, data, signal) {
      if (gone) return Promise.reject(new RelayGoneError());
      if (closed || signal?.aborted) return Promise.reject(signal?.reason ?? new Error("relay closed"));
      const r = randomId();
      const on = link ??= { abort: new AbortController(), epoch: randomId(), seq: 0, posts: Promise.resolve(), polling: false };
      return new Promise<RelayFrame>((resolve, reject) => {
        const finish = (error: unknown, frame?: RelayFrame) => {
          clearTimeout(timer);
          pending.delete(r);
          settled();
          signal?.removeEventListener("abort", onAbort);
          if (frame) resolve(frame); else reject(error);
        };
        const onAbort = () => finish(signal?.reason ?? new Error("relay control aborted"));
        const timer = setTimeout(() => finish(new Error("relay control timed out")), 15_000);
        const ignore = () => {};
        pending.set(r, { link: on, at: relayNow(), head: ignore, data: ignore, end: ignore, fail: (error) => finish(error), ctl: (frame) => finish(null, frame) });
        signal?.addEventListener("abort", onAbort, { once: true });
        void poll(on);
        void post(on, [{ t: "ctl", r, op, data }]).catch((error) => finish(error));
      });
    },
    request(method, path, headers = {}, body, signal, onBodyProgress) {
      if (gone) return Promise.reject(new RelayGoneError());
      if (closed || signal?.aborted) return Promise.reject(signal?.reason ?? new Error("relay closed"));
      if (!path.startsWith("/") || path.startsWith("//")) return Promise.reject(new Error("invalid relay path"));
      const r = randomId();
      const on = link ??= { abort: new AbortController(), epoch: randomId(), seq: 0, posts: Promise.resolve(), polling: false };
      return new Promise<Response>((resolve, reject) => {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        let headed = false, finished = false, empty = false;
        let timer = setTimeout(() => { void relocate(); cancel(new Error("relay request timed out")); }, 15_000);
        const cleanup = () => { finished = true; clearTimeout(timer); pending.delete(r); settled(); signal?.removeEventListener("abort", onAbort); };
        const fail = (error: unknown) => { if (finished) return; cleanup(); controller.error(error); reject(error); };
        const cancel = (error: unknown) => { fail(error); void post(on, [{ t: "cancel", r }]).catch(() => {}); };
        const onAbort = () => cancel(signal?.reason);
        const stream = new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          cancel() { if (!finished) { cleanup(); void post(on, [{ t: "cancel", r }]).catch(() => {}); } },
        }, { highWaterMark: 8 * 1024 * 1024, size: (chunk) => chunk.byteLength });
        pending.set(r, {
          link: on,
          at: relayNow(),
          head(frame) {
            if (headed) return;
            try {
              empty = method === "HEAD" || [204, 205, 304].includes(frame.status ?? 0);
              const response = new Response(empty ? null : stream, { status: frame.status, headers: frame.headers });
              headed = true;
              clearTimeout(timer);
              resolve(response);
            } catch (error) { fail(error); }
          },
          data(bytes) {
            if (!headed) { fail(new Error("relay body before headers")); return; }
            if (!empty) {
              if ((controller.desiredSize ?? 0) < bytes.length) { cancel(new Error("relay response too large")); return; }
              controller.enqueue(bytes);
            }
          },
          end() { if (!headed) { fail(new Error("relay ended before headers")); return; } cleanup(); controller.close(); },
          fail,
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        const send = async () => {
          await post(on, [{ t: "req", r, method, path, headers: Object.fromEntries(new Headers(headers)), end: !body?.length }]);
          if (body?.length) {
            onBodyProgress?.(0, body.length);
            for (let at = 0; at < body.length && pending.has(r); at += 128 * 1024) {
              await post(on, [{ t: "body", r, d: base64url(body.subarray(at, at + 128 * 1024)), end: at + 128 * 1024 >= body.length }]);
              onBodyProgress?.(Math.min(body.length, at + 128 * 1024), body.length);
              if (!pending.has(r)) break;
              // a long body still moving is not a stalled request: the wait for an answer counts from its last chunk
              if (!headed) {
                clearTimeout(timer);
                timer = setTimeout(() => cancel(new Error("relay request timed out")), 15_000);
              }
            }
          }
        };
        void poll(on);
        void send().catch(fail);
      });
    },
  };
}
