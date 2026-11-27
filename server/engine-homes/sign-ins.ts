// The team's engine sign-ins in an audience's home. Each audience keeps a copy where its engine looks; inside a bot box the
// team's file itself is bound over that copy, so a refreshed token lands in the team's file. Outside a box the engine
// writes its copy, and the next spawn in any audience takes the newest settled copy back into the team's file.
import { closeSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { SharedFile } from "./layout.ts";

/** A copy written this recently may be half-written by its engine. */
export const SETTLED_MS = 2_000;

const stat = (path: string, follow: boolean): Stats | null => {
  try { return follow ? statSync(path) : lstatSync(path); } catch { return null; }
};

const whole = (path: string, bytes: Buffer): boolean => {
  if (!path.endsWith(".json")) return bytes.length > 0;
  try { JSON.parse(bytes.toString("utf8")); return true; } catch { return false; }
};

function copyInto(target: string, bytes: Buffer, from: Stats): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.dusk`);
  writeFileSync(temporary, bytes, { mode: 0o600 });
  utimesSync(temporary, from.atime, from.mtime);
  renameSync(temporary, target);
}

/** In place, so a box that has the team's file bound keeps seeing it. */
function writeInPlace(source: string, bytes: Buffer, from: Stats): void {
  const fd = openSync(source, "r+");
  try {
    if (!fstatSync(fd).isFile()) return;
    writeFileSync(fd, bytes);
    ftruncateSync(fd, bytes.length);
  } finally {
    closeSync(fd);
  }
  utimesSync(source, from.atime, from.mtime);
}

export type SignInSync = "copied" | "taken back" | "removed" | "same";

/** What a login file holds, for the two refreshing logins Team Clouds share: `blank` when its tokens are gone (a refresh the
 * provider refused makes the CLI blank its file), `stamp` when its tokens were last renewed. Other files say nothing. */
export function loginFacts(path: string, bytes: Buffer): { blank: boolean; stamp: number | null } | null {
  const name = basename(path);
  if (name !== ".credentials.json" && name !== "auth.json") return null;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
    if (name === ".credentials.json") {
      const oauth = parsed?.claudeAiOauth;
      if (!oauth || typeof oauth !== "object") return null;
      const blank = !oauth.accessToken && !oauth.refreshToken;
      return { blank, stamp: typeof oauth.expiresAt === "number" && oauth.expiresAt > 0 ? oauth.expiresAt : null };
    }
    if (!parsed || typeof parsed !== "object" || !("tokens" in parsed || "OPENAI_API_KEY" in parsed)) return null;
    const tokens = parsed.tokens;
    const blank = !(tokens && typeof tokens === "object" && (tokens.refresh_token || tokens.access_token)) && !parsed.OPENAI_API_KEY;
    const stamp = typeof parsed.last_refresh === "string" ? Date.parse(parsed.last_refresh) : NaN;
    return { blank, stamp: Number.isFinite(stamp) ? stamp : null };
  } catch {
    return null;
  }
}

/** A copy that lost its login, or whose tokens are older than the team's, is never the newer one: taking it back would
 * hand every audience a refresh token the provider already retired. */
function staleOrBlank(path: string, copy: Buffer, team: Buffer): boolean {
  const mine = loginFacts(path, copy), held = loginFacts(path, team);
  if (!mine || !held) return false;
  if (mine.blank) return !held.blank;
  return mine.stamp !== null && held.stamp !== null && mine.stamp < held.stamp;
}

/** A copy an engine wrote outside a box after the team's file changed, once it has settled and reads whole. */
function newerCopy(path: string, team: Stats, now: number, teamBytes: Buffer): { bytes: Buffer; stats: Stats } | null {
  const copy = stat(path, false);
  if (!copy?.isFile() || Math.floor(copy.mtimeMs) <= Math.floor(team.mtimeMs) || now - copy.mtimeMs < SETTLED_MS) return null;
  const bytes = readFileSync(path);
  return whole(path, bytes) && !staleOrBlank(path, bytes, teamBytes) ? { bytes, stats: copy } : null;
}

/** `peers` are the same file in the other audiences' homes: the newest refresh any of them made becomes the team's. */
export function syncSignIn(file: SharedFile, peers: readonly string[] = [], now = Date.now()): SignInSync {
  let team = stat(file.source, true);
  let copy = stat(file.target, false);
  if (copy && !copy.isFile()) {
    rmSync(file.target, { recursive: true, force: true });
    copy = null;
  }
  if (!team?.isFile()) {
    if (!copy) return "same";
    rmSync(file.target, { force: true });
    return "removed";
  }
  let taken: SignInSync = "same";
  const teamBytes = readFileSync(file.source);
  const newest = [file.target, ...peers].map((path) => newerCopy(path, team!, now, teamBytes)).filter((found) => found !== null)
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)[0];
  if (newest) {
    writeInPlace(file.source, newest.bytes, newest.stats);
    team = stat(file.source, true)!;
    taken = "taken back";
  }
  const at = (stats: Stats) => Math.floor(stats.mtimeMs);
  if (copy && at(copy) > at(team) && now - copy.mtimeMs < SETTLED_MS) return taken;
  const bytes = readFileSync(file.source);
  if (copy && at(copy) === at(team) && copy.size === team.size && readFileSync(file.target).equals(bytes)) return taken;
  copyInto(file.target, bytes, team);
  return taken === "same" ? "copied" : taken;
}

export function syncSignIns(files: readonly SharedFile[], peers: (target: string) => readonly string[] = () => [], now = Date.now()): void {
  for (const file of files) {
    try { syncSignIn(file, peers(file.target), now); } catch {}
  }
}
