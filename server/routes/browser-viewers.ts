// People's views of a bot's browser. v1 (GET …/browser/live as server-sent events, POST …/browser/action) is what the
// phone apps speak, and its contract is frozen. v2 (GET …/browser/stream, a WebSocket) is the desktop panel's and the
// web UI's, on the new engine only: a page's file picker is answered by POST …/browser/upload and a finished download
// is fetched from GET …/browser/download/:id. Never mix login frames into the general events feed, which every device
// reads.
import { createReadStream, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";

import { BROWSER_UPLOAD_MAX_BYTES as UPLOAD_MAX_BYTES } from "../../shared/upload-limits.ts";
import type { Audience } from "../audience.ts";
import { storeUploads } from "../browser-upload.ts";
import type { BrowserLive } from "../browser-live.ts";
import type { LiveRouter } from "../browser/engines.ts";
import type { ClosedBrowser } from "../browser-recent-tabs.ts";
import { requestedSize } from "../browser/viewers/viewport.ts";
import { messageFileDisposition } from "../message-file.ts";
import { isSameOrigin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { Upgrades } from "./upgrades.ts";
import { isScreenFallbackReason, type ScreenFallbackReason } from "../../shared/screen-direct.ts";

const LIVE = /^\/api\/bots\/([\w-]+)\/browser\/(live|action)$/;
const STREAM = /^\/api\/bots\/([\w-]+)\/browser\/stream$/;
const UPLOAD = /^\/api\/bots\/([\w-]+)\/browser\/upload$/;
const DOWNLOAD = /^\/api\/bots\/([\w-]+)\/browser\/download\/([\w-]{1,64})$/;
const RECENT = /^\/api\/bots\/([\w-]+)\/browser\/recent(?:\/(\d{1,2}))?$/;
const CLOSE = /^\/api\/bots\/([\w-]+)\/browser\/close$/;
const CHOOSER = /^[\w-]{1,64}$/;
const UPLOAD_MAX_FILES = 20;
const PICKER_CLOSED = "The page's file picker is no longer open.";

type Spec = Parameters<BrowserLive["open"]>[0]["spec"];
type Failure = { status: number; error: string };

export interface BrowserViewerRouteDeps {
  upgrades: Upgrades;
  viewers: Pick<LiveRouter, "open" | "action" | "stream" | "fileChooserOffered" | "answerFileChooser" | "download">;
  /** Who is watching, as a hold of the browser knows them: every view and device of one person shares their hold. */
  person(auth: RequestAuth): string;
  /** Whose browser of the bot this person's view shows (`threadId` names the conversation they look at); null when
   * they may not see that conversation. */
  audience(auth: RequestAuth, threadId: string | null): Audience | null;
  /** A bot with its browser on, and the session and spec that audience's browser runs as. */
  browser(botId: string, audience: Audience): Promise<{ botId: string; session: string; spec: Spec } | Failure>;
  /** Hosted workspaces check the member's sign-in again before a view opens. */
  authorize(req: IncomingMessage, auth: RequestAuth): Promise<Failure | null>;
  /** Whether a view opened for `session` still shows the bot's current browser to a live sign-in. */
  current(botId: string, session: string, auth: RequestAuth, audience: Audience): boolean;
  dataDir: string;
  /** counts a stream that rides the relay, with why it is not direct */
  relayed?(reason: ScreenFallbackReason | null): void;
  /** Whether the bot's browser for this audience runs now, and the tabs it closed with in the last hour; never starts it. */
  recent?(botId: string, audience: Audience): Promise<{ open: boolean; closed: ClosedBrowser | null } | Failure>;
  /** Closes the bot's browser for this audience, keeping its tabs for `recent`; false when it was not running. */
  close?(botId: string, audience: Audience): Promise<{ closed: boolean } | Failure>;
}

const ownerOf = (auth: RequestAuth) => (auth.kind === "session" ? auth.session.id : "local-owner");

class UploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The multipart `file` parts of an upload, read whole: at most 20 files and 100 MiB in all. */
async function uploadedFiles(req: IncomingMessage): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const type = String(req.headers["content-type"] ?? "");
  if (!/^multipart\/form-data;/i.test(type)) throw new UploadError(415, "Send the files as multipart form data.");
  if (Number(req.headers["content-length"]) > UPLOAD_MAX_BYTES) throw new UploadError(413, "Those files are larger than 100 MB in all.");
  let bytes = 0;
  const limited = req.pipe(new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > UPLOAD_MAX_BYTES ? new UploadError(413, "Those files are larger than 100 MB in all.") : null, chunk);
    },
  }));
  req.once("error", (error) => limited.destroy(error));
  let form: FormData;
  try {
    form = await new Request("http://upload.invalid/", {
      method: "POST", headers: { "content-type": type }, body: Readable.toWeb(limited) as ReadableStream, duplex: "half",
    } as RequestInit).formData();
  } catch (error) {
    throw error instanceof UploadError ? error : bytes > UPLOAD_MAX_BYTES ? new UploadError(413, "Those files are larger than 100 MB in all.") : new UploadError(400, "The upload was not valid form data.");
  }
  const files = form.getAll("file").filter((entry): entry is File => typeof entry !== "string");
  if (files.length > UPLOAD_MAX_FILES) throw new UploadError(413, `A page takes at most ${UPLOAD_MAX_FILES} files at once.`);
  return Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
}

/** A refused upload's body of at most 64 KiB, as its declared length says, read to its end and dropped; false for a
 * larger, unsized or broken one, which is left unread. */
const SMALL_REFUSED_BODY = 64 * 1024;
function drainedSmallBody(req: IncomingMessage): Promise<boolean> {
  const declared = Number(req.headers["content-length"]);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > SMALL_REFUSED_BODY) return Promise.resolve(false);
  if (req.readableEnded) return Promise.resolve(true);
  return new Promise((resolve) => {
    req.once("end", () => resolve(true)).once("error", () => resolve(false)).once("close", () => resolve(req.readableEnded));
    req.resume();
  });
}

/** Gives an upload's files to the page's picker; null when it took them, else why not. Files it did not take are deleted. */
async function answerUpload(req: IncomingMessage, deps: BrowserViewerRouteDeps, browser: { session: string; spec: Spec }, owner: string, chooser: string): Promise<(Failure & { unread?: boolean }) | null> {
  let files: Array<{ name: string; bytes: Uint8Array }>;
  try { files = await uploadedFiles(req); }
  catch (error) {
    if (!(error instanceof UploadError)) throw error;
    return { status: error.status, error: error.message, unread: true };
  }
  const paths = storeUploads(files, join(deps.dataDir, "browser-uploads"));
  if (await deps.viewers.answerFileChooser(browser, owner, chooser, paths).catch(() => false)) return null;
  for (const file of paths) rmSync(dirname(file), { recursive: true, force: true });
  return { status: 409, error: PICKER_CLOSED };
}

type RouteArgs = Parameters<RouteHandler>[0];

/** The Computer tab's view of a bot's browser on this computer: open or not, and what it closed with. */
async function recentRoute(deps: BrowserViewerRouteDeps, botId: string, index: string | undefined,
  { req, res, url, method, auth, json }: Pick<RouteArgs, "req" | "res" | "url" | "method" | "auth" | "json">) {
  res.setHeader("cache-control", "no-store");
  if (method !== "GET") return json(res, 405, { error: "method not allowed" });
  const audience = deps.audience(auth, url.searchParams.get("threadId"));
  if (!audience) return json(res, 404, { error: "no such conversation" });
  const failure = await deps.authorize(req, auth);
  if (failure) return json(res, failure.status, { error: failure.error });
  const state = await deps.recent!(botId, audience);
  if ("error" in state) return json(res, state.status, { error: state.error });
  if (index === undefined) {
    return json(res, 200, { open: state.open, closed: state.closed && { at: state.closed.at,
      tabs: state.closed.tabs.map((tab) => ({ title: tab.title, url: tab.url, image: tab.image !== null })) } });
  }
  const image = state.closed?.tabs[Number(index)]?.image;
  if (!image) return json(res, 404, { error: "That screen is no longer kept." });
  res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(image.length), "x-content-type-options": "nosniff" });
  res.end(image);
}

/** The person closes a bot's browser from its Computer tab. */
async function closeRoute(deps: BrowserViewerRouteDeps, botId: string,
  { req, res, url, method, auth, json }: Pick<RouteArgs, "req" | "res" | "url" | "method" | "auth" | "json">) {
  res.setHeader("cache-control", "no-store");
  if (method !== "POST") return json(res, 405, { error: "method not allowed" });
  const audience = deps.audience(auth, url.searchParams.get("threadId"));
  if (!audience) return json(res, 404, { error: "no such conversation" });
  const failure = await deps.authorize(req, auth);
  if (failure) return json(res, failure.status, { error: failure.error });
  const result = await deps.close!(botId, audience);
  if ("error" in result) return json(res, result.status, { error: result.error });
  return json(res, 200, result);
}

export function createBrowserViewerRoutes(deps: BrowserViewerRouteDeps): RouteHandler {
  deps.upgrades.route((path) => STREAM.test(path));
  const uploading = new Set<string>();
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    const recent = RECENT.exec(path);
    if (recent && deps.recent) return recentRoute(deps, recent[1]!, recent[2], { req, res, url, method, auth, json });
    const close = CLOSE.exec(path);
    if (close && deps.close) return closeRoute(deps, close[1]!, { req, res, url, method, auth, json });
    const live = LIVE.exec(path);
    const stream = live ? null : STREAM.exec(path);
    const upload = live || stream ? null : UPLOAD.exec(path);
    const download = live || stream || upload ? null : DOWNLOAD.exec(path);
    const botId = (live ?? stream ?? upload ?? download)?.[1];
    if (!botId) return PASS;
    res.setHeader("cache-control", "no-store");
    const pending = stream ? deps.upgrades.pending(req) : undefined;
    if (stream) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!pending) return json(res, 426, { error: "WebSocket upgrade required" });
      if (!isSameOrigin(req)) return json(res, 403, { error: "forbidden: cross-origin request" });
    }
    const threadId = url.searchParams.get("threadId");
    const audience = deps.audience(auth, threadId);
    if (!audience) return json(res, 404, { error: "no such conversation" });
    const browser = await deps.browser(botId, audience);
    if ("error" in browser) return json(res, browser.status, { error: browser.error });
    // discovery may outlast revocation; never open a replacement on the earlier authorization.
    const failure = await deps.authorize(req, auth);
    if (failure) return json(res, failure.status, { error: failure.error });
    const owner = ownerOf(auth);
    const person = deps.person(auth);
    const isCurrent = () => deps.audience(auth, threadId) === audience && deps.current(browser.botId, browser.session, auth, audience);

    if (live) {
      if (method === "GET" && live[2] === "live") {
        req.socket.setTimeout(0);
        const size = requestedSize(Number(url.searchParams.get("width")), Number(url.searchParams.get("height")));
        return await deps.viewers.open({ botId: browser.botId, session: browser.session, spec: browser.spec, owner, person, isCurrent, res, resume: url.searchParams.get("resume"), size, together: url.searchParams.get("together") === "1" });
      }
      if (method === "POST" && live[2] === "action") {
        const body = await readBody(req, 32_768);
        if (!isCurrent()) return json(res, 409, { error: "This browser session changed. Reopen the browser panel." });
        if (typeof body?.viewerId !== "string") return json(res, 400, { error: "A live browser connection is required." });
        return json(res, 200, await deps.viewers.action({ viewerId: body.viewerId, botId: browser.botId, owner, body }));
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (stream && pending) {
      if (pending.socket.destroyed) return;
      if (!isCurrent()) return json(res, 409, { error: "This browser session changed. Reopen the browser panel." });
      pending.release();
      const opened = deps.viewers.stream({
        session: browser.session, spec: browser.spec, botId: browser.botId, owner, person,
        canOperate: url.searchParams.get("interactive") !== "false",
        params: url.searchParams, req, socket: pending.socket, head: pending.head,
        isCurrent,
      });
      if (!opened) return json(res, 409, { error: "This browser shows in the live view only." });
      // a stream the app could not take direct says why (server/screen-direct.ts counters); nothing personal
      const direct = url.searchParams.get("direct");
      if (direct !== null) deps.relayed?.(isScreenFallbackReason(direct) ? direct : null);
      res.detachSocket(pending.socket);
      return;
    }

    if (upload) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const chooser = url.searchParams.get("chooser") ?? "";
      if (!CHOOSER.test(chooser)) return json(res, 400, { error: "Name the page's file picker." });
      // Security: a body is read into memory only for the picker this person was offered, one upload of theirs at a time.
      const refused = !deps.viewers.fileChooserOffered(browser, owner, chooser) ? { status: 409, error: PICKER_CLOSED }
        : uploading.has(owner) ? { status: 429, error: "Your previous upload is still on its way. Wait for it, then try again." } : null;
      if (refused) {
        // a small body is read and dropped first, so the client gets this answer, not a reset while it still writes;
        // a larger one is never read and its connection closes
        if (!await drainedSmallBody(req)) res.setHeader("connection", "close");
        return json(res, refused.status, { error: refused.error });
      }
      uploading.add(owner);
      const unanswered = await answerUpload(req, deps, browser, owner, chooser).finally(() => uploading.delete(owner));
      if (!unanswered) {
        res.writeHead(204).end();
        return;
      }
      // The rest of a refused body is never read.
      if (unanswered.unread) res.setHeader("connection", "close");
      return json(res, unanswered.status, { error: unanswered.error });
    }

    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    const file = deps.viewers.download(browser, download![2]!);
    if (!file?.path) return json(res, 404, { error: "That download is not available." });
    const saved = file.path;
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(file.receivedBytes),
      "content-disposition": messageFileDisposition(file.fileName),
      "x-content-type-options": "nosniff",
    });
    await new Promise<void>((resolve) => {
      const reading = createReadStream(saved);
      reading.once("error", () => { res.destroy(); resolve(); });
      res.once("close", () => { reading.destroy(); resolve(); });
      reading.pipe(res);
    });
  };
}
