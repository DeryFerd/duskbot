// `duskbot update` and `duskbot version [--check]`: is there a newer server, what changed for it, and the one right way
// to update this install. The version comes from the signed release manifest (latest.json); the npm package is
// installed only after its sha256 matches the release's SHA256SUMS, whose own sha256 the signature vouches for.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { parseReleaseKeys } from "../apps/cloud-service/src/release-signing.ts";
import { cloudHomeConfigured } from "./cloud-home.ts";
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME } from "./service-unit.ts";
import { DESKTOP_RELEASE_KEYS, installKind, LINKED_MARKER, newerVersion, OFFICIAL_SERVER_IMAGE, tracksOfficialLatest, verifiedDesktopRelease } from "./update-check.ts";

export const RELEASE_FEED = "https://dusk.bot/releases";
export const CHANGELOG_PAGE = "https://dusk.bot/changelog";
export const SERVER_DOCS = "https://dusk.bot/docs/your-own-server";
const ISSUES = "https://github.com/DuskBotAI/duskbot";
/** exit code of `update --check` (and of an `update` that did not install) when a newer release is out */
export const EXIT_UPDATE_AVAILABLE = 10;
const LINK_TIMER = "/etc/systemd/system/duskbot-server-update.timer";
const LINK_UPDATE_SERVICE = "duskbot-server-update.service";
const LINK_UPDATE_LOG = "/var/log/duskbot-link/server-update.log";
const PACKAGE_CAP = 512 * 1024 * 1024;

export type UpdateInstall = "desktop" | "managed" | "docker" | "podman" | "link" | "npm" | "git" | "unknown";

export interface UpdateArgs {
  command: "update" | "version";
  check: boolean;
  yes: boolean;
  json: boolean;
  verbose: boolean;
}

export function parseUpdateArgs(argv: string[]): UpdateArgs | { error: string } {
  const [command, ...rest] = argv;
  if (command !== "update" && command !== "version") return { error: `unknown command "${command}"` };
  const args: UpdateArgs = { command, check: false, yes: false, json: false, verbose: false };
  for (const arg of rest) {
    if (arg === "--check") args.check = true;
    else if (command === "update" && (arg === "--yes" || arg === "-y")) args.yes = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--verbose") args.verbose = true;
    else return { error: `unknown argument "${arg}"` };
  }
  if (args.check && args.yes) return { error: "--check only looks; drop --yes" };
  return args;
}

export interface UpdateProbes {
  current: string;
  /** the folder of the running bundle (dist-server) */
  serverRoot: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  isRoot: boolean;
  isTTY: boolean;
  fetch: typeof fetch;
  exists(path: string): boolean;
  writable(path: string): boolean;
  run(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  confirm(question: string): Promise<boolean>;
  tmpDir(): string;
  log(line: string): void;
  error(line: string): void;
}

export function defaultUpdateProbes(current: string, serverRoot: string): UpdateProbes {
  const env = process.env;
  // a test feed may also stand in for the machine's own marker files (/.dockerenv, the link's state), never the real feed
  const fsRoot = env.DUSK_RELEASE_FEED && env.DUSK_UPDATE_FS_ROOT ? env.DUSK_UPDATE_FS_ROOT : "";
  return {
    current, serverRoot, env, platform: process.platform, home: homedir(),
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    fetch: (...args) => fetch(...args),
    exists: (path) => existsSync(fsRoot && path.startsWith("/") ? join(fsRoot, path) : path),
    writable: (path) => { try { accessSync(path, constants.W_OK); return true; } catch { return false; } },
    run: (file, args) => new Promise((done) => {
      execFile(file, args, { encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error && !stderr ? error.message : "") });
      });
    }),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
    },
    tmpDir: () => mkdtempSync(join(tmpdir(), "duskbot-update-")),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

/** where an npm global install of this package lives: `<prefix>/lib/node_modules/duskbot` (Windows: `<prefix>/node_modules/duskbot`) */
export function npmInstallOf(serverRoot: string, platform: NodeJS.Platform): { prefix: string; packageDir: string; modules: string } | null {
  const parts = serverRoot.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 1 || parts[at + 1] !== "duskbot" || parts.includes("_npx")) return null;
  const modules = parts.slice(0, at + 1).join(sep);
  if (platform === "win32") return { prefix: parts.slice(0, at).join(sep), packageDir: join(modules, "duskbot"), modules };
  if (parts[at - 1] !== "lib" || at < 2) return null;
  return { prefix: parts.slice(0, at - 1).join(sep) || sep, packageDir: join(modules, "duskbot"), modules };
}

export function detectInstall(probes: Pick<UpdateProbes, "env" | "serverRoot" | "exists">): UpdateInstall {
  const kind = installKind({
    desktopManaged: probes.env.DUSK_DESKTOP_PARENT === "1",
    managed: cloudHomeConfigured(probes.env),
    serverRoot: probes.serverRoot,
    exists: probes.exists,
  });
  // the link's installer puts an npm global install under its own account and updates it from a timer
  if (kind === "npm" && probes.exists(LINKED_MARKER) && probes.exists(LINK_TIMER)) return "link";
  return kind;
}

export interface ChangeItem { text: string; area: string; issue?: number; pr?: number; url?: string }
export interface ChangeRelease { version: string; date?: string; title?: string; items: ChangeItem[] }

const AREAS = new Set(["desktop", "phone", "server", "cli", "all"]);
const SERVER_AREAS = new Set(["server", "cli", "all"]);
// the changelog is not signed: keep its text to one plain line a terminal cannot be steered by
// oxlint-disable-next-line no-control-regex
const plain = (value: string, max = 300) => value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const positive = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 && value < 1e7 ? value : undefined;

/** the server and CLI changes between `current` (not included) and `latest`, newest first; [] for a missing or odd file */
export function serverChanges(body: unknown, current: string, latest: string): ChangeRelease[] {
  const releases = body && typeof body === "object" ? (body as { releases?: unknown }).releases : undefined;
  if (!Array.isArray(releases)) return [];
  const out: ChangeRelease[] = [];
  for (const entry of releases.slice(0, 500)) {
    if (!entry || typeof entry !== "object") continue;
    const { version, date, title, items } = entry as Record<string, unknown>;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || !Array.isArray(items)) continue;
    if (!newerVersion(version, current) || newerVersion(version, latest)) continue;
    const kept: ChangeItem[] = [];
    for (const item of items.slice(0, 200)) {
      if (!item || typeof item !== "object") continue;
      const { text, area, issue, pr } = item as Record<string, unknown>;
      if (typeof text !== "string" || !plain(text) || typeof area !== "string" || !AREAS.has(area) || !SERVER_AREAS.has(area)) continue;
      const change: ChangeItem = { text: plain(text), area };
      if (positive(issue)) change.issue = positive(issue);
      if (positive(pr)) change.pr = positive(pr);
      if (change.issue) change.url = `${ISSUES}/issues/${change.issue}`;
      else if (change.pr) change.url = `${ISSUES}/pull/${change.pr}`;
      kept.push(change);
    }
    if (!kept.length) continue;
    out.push({ version, ...(typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}), ...(typeof title === "string" && plain(title, 120) ? { title: plain(title, 120) } : {}), items: kept });
  }
  return out.sort((a, b) => (newerVersion(a.version, b.version) ? -1 : newerVersion(b.version, a.version) ? 1 : 0));
}

/** a plain sentence for the person, the raw cause for --verbose */
class UpdateError extends Error {
  readonly raw?: unknown;
  constructor(message: string, raw?: unknown) { super(message); this.raw = raw; }
}

function feedOf(env: NodeJS.ProcessEnv): { base: string; overridden: boolean; keys: readonly { kid: string; x: string }[] } {
  const custom = env.DUSK_RELEASE_FEED?.trim();
  if (!custom) return { base: RELEASE_FEED, overridden: false, keys: DESKTOP_RELEASE_KEYS };
  let url: URL;
  try { url = new URL(custom); } catch (error) { throw new UpdateError("DUSK_RELEASE_FEED is not a web address.", error); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UpdateError("DUSK_RELEASE_FEED must start with https://.");
  let extra: { kid: string; x: string }[];
  try { extra = parseReleaseKeys(env.DUSK_RELEASE_PUBLIC_KEYS); } catch (error) { throw new UpdateError("DUSK_RELEASE_PUBLIC_KEYS is not a list of kid:key pairs.", error); }
  return { base: url.href.replace(/\/+$/, ""), overridden: true, keys: [...DESKTOP_RELEASE_KEYS, ...extra] };
}

async function getText(probes: UpdateProbes, url: string, what: string, cap = 2 * 1024 * 1024): Promise<{ status: number; text: string; bytes: Buffer }> {
  let response: Response;
  try {
    response = await probes.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { accept: "application/json, text/plain" } });
  } catch (error) {
    throw new UpdateError(`Couldn't reach ${what}. Check this machine's internet connection and try again.`, error);
  }
  if (!response.ok) {
    if (response.status === 404) return { status: 404, text: "", bytes: Buffer.alloc(0) };
    throw new UpdateError(`${what} answered with an error (${response.status}). Try again in a few minutes.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > cap) throw new UpdateError(`${what} sent more than expected, so it was ignored.`);
  return { status: response.status, text: bytes.toString("utf8"), bytes };
}

interface CliPackage { version: string; url: string; sha256?: string }

function cliPackageOf(body: unknown, latest: string): CliPackage | null {
  const cli = body && typeof body === "object" ? (body as { cli?: unknown }).cli : undefined;
  if (!cli || typeof cli !== "object") return null;
  const { version, url, sha256 } = cli as Record<string, unknown>;
  if (version !== latest || typeof url !== "string") return null;
  return { version, url, ...(typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256) ? { sha256 } : {}) };
}

export interface UpdateReport {
  current: string;
  latest: string | null;
  available: boolean;
  install: UpdateInstall;
  changes: ChangeRelease[];
  changelog: string;
  action: { kind: "none" | "install" | "command" | "automatic" | "app" | "managed" | "manual"; message: string; command?: string };
  installed?: string;
  error?: string;
}

/** what to do for this install, worded for the person reading it */
function actionFor(install: UpdateInstall, latest: string, probes: UpdateProbes): UpdateReport["action"] {
  switch (install) {
    case "desktop":
      return { kind: "app", message: "The dusk bot app runs this server and updates it. Update the app, or get it from https://dusk.bot/download" };
    case "managed":
      return { kind: "managed", message: "dusk cloud keeps this server up to date for you. Nothing to do." };
    case "docker":
    case "podman": {
      const tool = install === "podman" ? "podman compose" : "docker compose";
      const image = probes.env.DUSK_COMPOSE_IMAGE;
      if (image && !tracksOfficialLatest(image) && image.startsWith(OFFICIAL_SERVER_IMAGE)) {
        return { kind: "command", command: `${tool} up -d`, message: `This server runs in a container pinned to ${image}. On the host, set DUSK_IMAGE to ${OFFICIAL_SERVER_IMAGE}:v${latest}, then run: ${tool} up -d` };
      }
      const command = `${tool} pull dusk && ${tool} up -d`;
      return { kind: "command", command, message: `This server runs in a container and is updated from the host. In the folder with its compose file, run: ${command}` };
    }
    case "link":
      return { kind: "automatic", command: `sudo systemctl start ${LINK_UPDATE_SERVICE}`, message: "This server was set up from the dusk bot app and installs new versions itself while no bot is working. It looks every 15 minutes." };
    case "npm": {
      const where = npmInstallOf(probes.serverRoot, probes.platform);
      if (!where) return { kind: "manual", message: `This copy of duskbot does not run from a lasting npm install, so it can't update itself. Install it as ${SERVER_DOCS} shows.` };
      return { kind: "install", command: "duskbot update", message: `duskbot update downloads ${latest}, checks it against the signed release and installs it into ${where.prefix}.` };
    }
    case "git": {
      const command = "git pull && pnpm install && pnpm build:server";
      return { kind: "command", command, message: `This server runs from a git checkout. In ${dirname(probes.serverRoot)}, run: ${command}, then restart the server.` };
    }
    default:
      return { kind: "manual", message: `Get the server package from ${ISSUES}/releases/tag/v${latest} and follow ${SERVER_DOCS}` };
  }
}

function restartHint(probes: UpdateProbes): string {
  if (probes.platform === "linux" && probes.exists(`/etc/systemd/system/${SYSTEMD_UNIT_NAME}`)) return "Restart the server to use it: sudo systemctl restart duskbot";
  if (probes.platform === "darwin" && probes.exists(join(probes.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`))) {
    return `Restart the server to use it: launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`;
  }
  return "If the server is running, stop it and start it again to use the new version.";
}

async function download(probes: UpdateProbes, url: string, file: string): Promise<string> {
  let response: Response;
  try {
    response = await probes.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  } catch (error) {
    throw new UpdateError("Couldn't download the update. Check this machine's internet connection and try again.", error);
  }
  if (!response.ok || !response.body) throw new UpdateError(`The update download answered with an error (${response.status}). Try again in a few minutes.`);
  if (Number(response.headers.get("content-length") ?? 0) > PACKAGE_CAP) throw new UpdateError("The update download is larger than any release, so it was refused.");
  const hash = createHash("sha256");
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > PACKAGE_CAP) return done(new UpdateError("The update download is larger than any release, so it was refused."));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), count, createWriteStream(file, { mode: 0o600 }));
  } catch (error) {
    throw error instanceof UpdateError ? error : new UpdateError("The update download stopped part way. Try again.", error);
  }
  return hash.digest("hex");
}

function npmCommand(probes: UpdateProbes): { file: string; lead: string[] } {
  // npm.cmd cannot run without a shell on Windows; its own script runs under this node
  if (probes.platform === "win32") return { file: process.execPath, lead: [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] };
  return { file: "npm", lead: [] };
}

function installedVersion(packageDir: string): string | null {
  try {
    const version = Reflect.get(Object(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))), "version");
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

async function installNpm(probes: UpdateProbes, feed: ReturnType<typeof feedOf>, manifest: unknown, latest: string, sumsSha: string, say: (line: string) => void): Promise<string> {
  const where = npmInstallOf(probes.serverRoot, probes.platform);
  if (!where) throw new UpdateError(`This copy of duskbot does not run from a lasting npm install, so it can't update itself. See ${SERVER_DOCS}`);
  if (!probes.writable(where.modules)) {
    throw new UpdateError(`Installing into ${where.prefix} needs more rights than this account has. Run it again as the account that installed duskbot, or with sudo: sudo "$(command -v duskbot)" update --yes`);
  }
  // the hashes of every file in the release, as signed
  const sums = await getText(probes, `${feed.base}/${latest}/SHA256SUMS`, "dusk.bot");
  if (sums.status === 404) throw new UpdateError(`The checksums for ${latest} aren't published yet, so nothing was installed. Try again later.`);
  if (createHash("sha256").update(sums.bytes).digest("hex") !== sumsSha) {
    throw new UpdateError("The release checksums don't match the signed release, so nothing was installed.");
  }
  const lines = new Map<string, string>();
  for (const line of sums.text.split("\n")) {
    const match = /^([a-f0-9]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (match) lines.set(match[2]!, match[1]!);
  }
  const listed = cliPackageOf(manifest, latest);
  const url = listed?.url ?? `https://github.com/DuskBotAI/duskbot-releases/releases/download/v${latest}/duskbot-${latest}.tgz`;
  let parsed: URL;
  try { parsed = new URL(url); } catch (error) { throw new UpdateError("The release names a download that isn't a web address, so nothing was installed.", error); }
  if (parsed.protocol !== "https:" && !(feed.overridden && parsed.protocol === "http:")) throw new UpdateError("The release names a download that isn't https, so nothing was installed.");
  const name = basename(parsed.pathname);
  if (!/^duskbot(-\d+\.\d+\.\d+)?\.tgz$/.test(name)) throw new UpdateError("The release names a download that isn't a server package, so nothing was installed.");
  const expected = lines.get(name);
  if (!expected) throw new UpdateError(`The server package for ${latest} isn't published, so nothing was installed. See ${SERVER_DOCS}`);
  if (listed?.sha256 && listed.sha256 !== expected) throw new UpdateError("The release names a server package that doesn't match its checksums, so nothing was installed.");

  const dir = probes.tmpDir();
  try {
    const file = join(dir, `duskbot-${latest}.tgz`);
    say(`Downloading dusk bot ${latest}...`);
    const got = await download(probes, url, file);
    if (got !== expected) throw new UpdateError("The downloaded server package doesn't match the signed release, so nothing was installed.", new Error(`sha256 ${got}, expected ${expected}`));
    say(`Installing into ${where.prefix}...`);
    const npm = npmCommand(probes);
    const result = await probes.run(npm.file, [...npm.lead, "install", "--global", "--no-fund", "--no-audit", "--prefix", where.prefix, file]);
    if (result.code !== 0) throw new UpdateError("npm couldn't install the update. The version you had is still installed.", new Error(result.stderr.trim() || `npm exited ${result.code}`));
    const now = installedVersion(where.packageDir);
    if (now !== latest) throw new UpdateError(`npm finished, but ${where.packageDir} still holds ${now ?? "no readable version"}.`);
    return now;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function printReport(report: UpdateReport, probes: UpdateProbes): void {
  const { current, latest } = report;
  if (!latest) return;
  if (!report.available) {
    probes.log(newerVersion(current, latest) ? `dusk bot ${current} is newer than the latest release (${latest}).` : `dusk bot ${current} is up to date.`);
    return;
  }
  probes.log(`dusk bot ${latest} is out (you have ${current}).`);
  if (report.changes.length) {
    probes.log("");
    probes.log("What's new for your server:");
    for (const release of report.changes) {
      probes.log(`  ${release.version}${release.title ? `: ${release.title}` : ""}`);
      for (const item of release.items) probes.log(`  - ${item.text}${item.url ? `  ${item.url}` : ""}`);
    }
  }
  probes.log(`Full changelog: ${report.changelog}`);
  probes.log("");
  probes.log(report.action.message);
}

export async function runUpdate(args: UpdateArgs, probes: UpdateProbes): Promise<number> {
  const install = detectInstall(probes);
  const say = (line: string) => (args.json ? probes.error(line) : probes.log(line));
  if (args.command === "version" && !args.check) {
    const where = install === "npm" || install === "link" ? npmInstallOf(probes.serverRoot, probes.platform)?.prefix : undefined;
    if (args.json) probes.log(JSON.stringify({ version: probes.current, install, ...(where ? { prefix: where } : {}) }, null, 2));
    else probes.log(`dusk bot ${probes.current} (${install === "link" ? "linked server" : install}${where ? `, ${where}` : ""})`);
    return 0;
  }
  const report: UpdateReport = {
    current: probes.current, latest: null, available: false, install, changes: [], changelog: CHANGELOG_PAGE, action: { kind: "none", message: "" },
  };
  const fail = (error: unknown): number => {
    const plainLine = error instanceof UpdateError ? error.message : "Something went wrong while updating. Run it again with --verbose to see why.";
    report.error = plainLine;
    if (args.json) probes.log(JSON.stringify(report, null, 2));
    else probes.error(plainLine);
    const cause = error instanceof UpdateError ? error.raw : error;
    if (args.verbose && cause) probes.error(`cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  };
  try {
    const feed = feedOf(probes.env);
    const [manifestText, changelogText] = await Promise.all([
      getText(probes, `${feed.base}/latest.json`, "dusk.bot"),
      getText(probes, `${feed.base}/changelog.json`, "dusk.bot").catch(() => null),
    ]);
    if (manifestText.status === 404) throw new UpdateError("dusk.bot has no release to compare with right now. Try again later.");
    let manifest: unknown;
    try { manifest = JSON.parse(manifestText.text); } catch (error) { throw new UpdateError("The release information from dusk.bot couldn't be read. Try again later.", error); }
    const signed = verifiedDesktopRelease(manifest, feed.keys);
    if (!signed) throw new UpdateError("The release information from dusk.bot didn't pass its signature check, so nothing was changed.");
    const latest = signed.version;
    report.latest = latest;
    report.available = newerVersion(latest, probes.current);
    if (changelogText && changelogText.status !== 404) {
      try { report.changes = serverChanges(JSON.parse(changelogText.text), probes.current, latest); } catch { report.changes = []; }
    }
    if (!report.available) {
      report.action = { kind: "none", message: "Nothing to do." };
      if (args.json) probes.log(JSON.stringify(report, null, 2));
      else printReport(report, probes);
      return 0;
    }
    report.action = actionFor(install, latest, probes);
    if (args.json && (args.check || !(args.yes && (install === "npm" || install === "link")))) {
      probes.log(JSON.stringify(report, null, 2));
      return EXIT_UPDATE_AVAILABLE;
    }
    if (!args.json) printReport(report, probes);
    if (args.check) return EXIT_UPDATE_AVAILABLE;

    if (install === "link") {
      if (!args.yes || !probes.isRoot) {
        say(`To look for it now instead of waiting: ${report.action.command}`);
        return EXIT_UPDATE_AVAILABLE;
      }
      const result = await probes.run("systemctl", ["start", "--no-block", LINK_UPDATE_SERVICE]);
      if (result.code !== 0) throw new UpdateError("The server's updater didn't start. Its log may say why: " + LINK_UPDATE_LOG, new Error(result.stderr.trim()));
      say(`Started the server's updater. It installs ${latest} once no bot is working; its log is ${LINK_UPDATE_LOG}`);
      if (args.json) probes.log(JSON.stringify(report, null, 2));
      return 0;
    }
    if (install !== "npm" || report.action.kind !== "install") return EXIT_UPDATE_AVAILABLE;
    if (!args.yes) {
      if (!probes.isTTY) {
        say("Run duskbot update --yes to install it.");
        return EXIT_UPDATE_AVAILABLE;
      }
      say("");
      if (!(await probes.confirm(`Install dusk bot ${latest} now?`))) {
        say("Nothing was changed.");
        return EXIT_UPDATE_AVAILABLE;
      }
    }
    report.installed = await installNpm(probes, feed, manifest, latest, signed.sha256, say);
    say(`Installed dusk bot ${report.installed}.`);
    say(restartHint(probes));
    if (args.json) probes.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    return fail(error);
  }
}

/** `duskbot update|version|--version`, from cli.ts */
export async function runUpdateCli(argv: string[], current: string, serverRoot: string, usage: string): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-v") { console.log(current); return 0; }
  const args = parseUpdateArgs(argv);
  if ("error" in args) { console.error(`${args.error}\n\n${usage}`); return 2; }
  return runUpdate(args, defaultUpdateProbes(current, serverRoot));
}
