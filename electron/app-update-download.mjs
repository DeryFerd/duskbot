// the update zip's download: resumes its .part with an HTTP Range request, tries the next source after a failure, waits
// a little longer after each that got nothing, and gives up on a connection that sends nothing for STALL_MS (a mac that slept leaves a
// socket that never errors on its own). the file only takes its real name once its sha256 matches.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, renameSync, rmSync, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const STALL_MS = 60_000;
export const HEADERS_MS = 30_000;
export const BACKOFF_MS = Object.freeze([2_000, 5_000, 15_000, 30_000, 60_000]);
/** tries in a row that add nothing to the .part before the download gives up; a try that adds bytes does not count,
 * up to this many times as many tries in all */
export const ATTEMPTS = 6;
const PROGRESS_TRIES_PER_ATTEMPT = 8;

/** an update failure with the stage it happened at and a short code (a word, never a path or a url) */
export class UpdateError extends Error {
  constructor(stage, code, message = code) {
    super(message);
    this.stage = stage;
    this.code = code;
  }
}

const DISK = new Set(["ENOSPC", "EDQUOT"]);
const ACCESS = new Set(["EACCES", "EPERM", "EROFS"]);

/** a short word for any failure, safe for analytics: [a-z0-9_], at most 40 characters, no paths, urls or quoted text */
export function failReason(error) {
  if (error instanceof UpdateError) return word(error.code);
  const code = typeof error?.code === "string" ? error.code : typeof error?.cause?.code === "string" ? error.cause.code : null;
  if (code && DISK.has(code)) return "disk_full";
  if (code && ACCESS.has(code)) return "no_access";
  if (error?.name === "TimeoutError") return "timeout";
  const message = String(error instanceof Error ? error.message : error ?? "");
  if (/^terminated$/i.test(message.trim())) return code ? word(`terminated_${code}`) : "terminated";
  if (code) return word(code);
  return word(message);
}

function word(text) {
  const slug = String(text)
    .replace(/[a-z]+:\/\/\S+/gi, " ")
    // a path may hold spaces (a person's name), so everything after where one starts goes
    .replace(/(?:~|\.{0,2})?\/.*$/s, " ")
    .replace(/[A-Za-z]:\\.*$/s, " ")
    .replace(/(["'`]).*?\1/g, " ")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 40).replace(/_+$/, "");
  return slug || "unknown";
}

const sizeOf = (file) => statSync(file, { throwIfNoEntry: false })?.size ?? 0;

export async function hashOf(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * one try at `url` from where `part` ends. `onBytes(have, total)` hears every chunk; `setKick(fn)` gets a way to end
 * this try at once (the mac woke). resolves when the source has sent everything.
 */
async function attempt({ url, part, fetchImpl, stallMs, headersMs, onBytes, setKick }) {
  const have = sizeOf(part);
  const control = new AbortController();
  let why = null;
  const stop = (error) => { why ??= error; control.abort(); };
  let timer = setTimeout(() => stop(new UpdateError("download", "no_answer")), headersMs);
  setKick(() => stop(new UpdateError("download", "woke")));
  try {
    const response = await fetchImpl(url, { signal: control.signal, cache: "no-store", headers: have > 0 ? { range: `bytes=${have}-` } : {} });
    if (response.status === 416 && have > 0) { await response.body?.cancel?.().catch(() => {}); return; }
    if ((response.status !== 200 && response.status !== 206) || !response.body) {
      await response.body?.cancel?.().catch(() => {});
      throw new UpdateError("download", `http_${response.status}`, `the update download answered ${response.status}`);
    }
    let start = 0, total = Number(response.headers.get("content-length")) || null;
    if (response.status === 206) {
      const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
      if (!range || Number(range[1]) !== have) {
        await response.body.cancel().catch(() => {});
        rmSync(part, { force: true });
        throw new UpdateError("download", "bad_range");
      }
      start = have;
      total = range[2] === "*" ? null : Number(range[2]);
    }
    clearTimeout(timer);
    timer = setTimeout(() => stop(new UpdateError("download", "stalled")), stallMs);
    let got = start;
    onBytes(got, total);
    const count = new Transform({ transform(chunk, _encoding, next) {
      got += chunk.length;
      timer.refresh();
      onBytes(got, total);
      next(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), count, createWriteStream(part, { flags: start > 0 ? "a" : "w" }), { signal: control.signal });
  } catch (error) {
    throw why ?? error;
  } finally {
    clearTimeout(timer);
    setKick(null);
  }
}

const fatal = (error) => error instanceof UpdateError ? false : DISK.has(error?.code) || ACCESS.has(error?.code);

/**
 * `file` with the bytes whose sha256 is `sha256`, from `sources` (urls of the same file, tried in turn). keeps what an
 * earlier try left in `${file}.part`. `onProgress(fraction | null)`, `onRetry(error, attempt)` before each wait.
 */
export async function resumableDownload({ sources, file, sha256, fetchImpl = fetch, attempts = ATTEMPTS, stallMs = STALL_MS, headersMs = HEADERS_MS, backoffMs = BACKOFF_MS,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onProgress = () => {}, onRetry = () => {}, onSource = () => {}, setKick = () => {} }) {
  if (sizeOf(file) > 0) {
    try { if (await hashOf(file) === sha256) return file; } catch { /* read again below */ }
    rmSync(file, { force: true });
  }
  const part = `${file}.part`;
  let source = 0, lastError = null, mismatched = false, fruitless = 0;
  for (let tried = 0; tried < attempts * PROGRESS_TRIES_PER_ATTEMPT; tried += 1) {
    const url = sources[source % sources.length];
    const before = sizeOf(part);
    onSource(url);
    try {
      await attempt({ url, part, fetchImpl, stallMs, headersMs, setKick, onBytes: (got, total) => onProgress(total ? Math.min(got / total, 1) : null) });
      if (await hashOf(part) === sha256) { renameSync(part, file); return file; }
      rmSync(part, { force: true });
      if (mismatched) throw new UpdateError("checksum", "checksum", "the update did not match its checksum");
      mismatched = true;
      lastError = new UpdateError("checksum", "checksum", "the update did not match its checksum");
    } catch (error) {
      if (fatal(error) || (error instanceof UpdateError && error.stage === "checksum")) throw asDownloadError(error);
      lastError = error;
    }
    source += 1;
    fruitless = sizeOf(part) > before ? 0 : fruitless + 1;
    if (fruitless >= attempts) break;
    onRetry(lastError, tried + 1);
    const woke = lastError instanceof UpdateError && lastError.code === "woke";
    await wait(woke ? 0 : backoffMs[Math.min(Math.max(fruitless - 1, 0), backoffMs.length - 1)]);
  }
  throw asDownloadError(lastError ?? new UpdateError("download", "no_source"));
}

const asDownloadError = (error) => error instanceof UpdateError ? error : new UpdateError("download", failReason(error), error instanceof Error ? error.message : String(error));
