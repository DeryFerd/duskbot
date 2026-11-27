// every file a dusk bot release carries on GitHub, in one list, so a self-hoster always finds the desktop apps, the
// Android APK, the server and CLI package and the Docker tag in the same release. release.yml's assemble job,
// publish-downloads.sh and release-all.ts check against it. Run it on a folder of release files to check the set, pack
// the CLI, carry the newest APK forward and write SHA256SUMS and latest.json (signed when DUSK_RELEASE_SIGNING_KEY is
// set, else marked as a dry run):
//
//   node scripts/release-assets.ts 0.2.32 --dir release/gh [--pack-cli] [--apk FILE | --carry-apk] [--dry-run] [--json]
//
// --pack-cli builds duskbot-<version>.tgz and duskbot.tgz from dist-server/ and dist/ (pnpm build:server && pnpm exec
// vite build first). --carry-apk takes DuskBot.apk from the downloads repo's latest release when this release built none.
// The APK's version comes from aapt2 (Android SDK build-tools), or --apk-version 1.2.12 --apk-code 13.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_REPO = "DuskBotAI/duskbot";
export const DOWNLOADS_REPO = "DuskBotAI/duskbot-releases";
export const SERVER_IMAGE = "ghcr.io/duskbotai/duskbot";

export type AssetKind = "mac" | "windows" | "linux" | "android" | "cli" | "checksums" | "manifest";
export interface Asset {
  name: string;
  kind: AssetKind;
  /** what a person picks it for, in the release notes' downloads table */
  label: string;
  /** a stable name the download page and /releases/latest/download/ links use */
  stable?: boolean;
  /** goes to the public downloads repo too (publish-downloads.sh) */
  public: boolean;
}

/** the full set, in the order the release notes list them */
export function releaseAssets(version: string): Asset[] {
  const v = version;
  return [
    { name: "DuskBot.dmg", kind: "mac", label: "Mac, Apple silicon", stable: true, public: true },
    { name: "DuskBot-intel.dmg", kind: "mac", label: "Mac, Intel", stable: true, public: true },
    { name: `DuskBot-${v}-arm64.dmg`, kind: "mac", label: "Mac, Apple silicon", public: false },
    { name: `DuskBot-${v}-x64.dmg`, kind: "mac", label: "Mac, Intel", public: false },
    { name: `DuskBot-${v}-arm64.zip`, kind: "mac", label: "Mac update, Apple silicon", public: true },
    { name: `DuskBot-${v}-x64.zip`, kind: "mac", label: "Mac update, Intel", public: true },
    { name: `DuskBot-${v}-browser-darwin-arm64.zip`, kind: "mac", label: "Mac bots' browser, Apple silicon", public: true },
    { name: `DuskBot-${v}-browser-darwin-x64.zip`, kind: "mac", label: "Mac bots' browser, Intel", public: true },
    { name: "DuskBot-setup.exe", kind: "windows", label: "Windows 10 and 11, installer", stable: true, public: true },
    { name: `DuskBot-${v}-setup.exe`, kind: "windows", label: "Windows installer", public: false },
    { name: "DuskBot-windows.zip", kind: "windows", label: "Windows, portable", stable: true, public: true },
    { name: `DuskBot-${v}-win-x64.zip`, kind: "windows", label: "Windows, portable", public: false },
    { name: "DuskBot-amd64.deb", kind: "linux", label: "Linux x64, Ubuntu and Debian", stable: true, public: true },
    { name: "DuskBot.AppImage", kind: "linux", label: "Linux x64, other distros", stable: true, public: true },
    { name: `DuskBot-${v}-amd64.deb`, kind: "linux", label: "Linux .deb", public: false },
    { name: `DuskBot-${v}-x86_64.AppImage`, kind: "linux", label: "Linux AppImage", public: false },
    { name: "DuskBot.apk", kind: "android", label: "Android phone", stable: true, public: true },
    { name: "duskbot.tgz", kind: "cli", label: "Server and CLI (Node 24+, any OS)", stable: true, public: true },
    { name: `duskbot-${v}.tgz`, kind: "cli", label: "Server and CLI", public: true },
    { name: "SHA256SUMS", kind: "checksums", label: "Checksums", public: true },
    { name: "latest.json", kind: "manifest", label: "Signed update manifest", public: true },
  ];
}

export interface Check { present: Asset[]; missing: Asset[]; extra: string[] }
export function checkAssets(version: string, names: readonly string[]): Check {
  const want = releaseAssets(version), have = new Set(names);
  const known = new Set(want.map(a => a.name));
  return { present: want.filter(a => have.has(a.name)), missing: want.filter(a => !have.has(a.name)), extra: names.filter(n => !known.has(n)).sort() };
}

export const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** versionName and versionCode out of `aapt2 dump badging` */
export function parseBadging(text: string): { version: string; code: number } | null {
  const m = /^package: name='[^']+' versionCode='(\d+)' versionName='([^']+)'/m.exec(text);
  return m ? { version: m[2]!, code: Number(m[1]) } : null;
}

function aapt2(): string | null {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library", "Android", "sdk"), join(homedir(), "android-sdk")].filter(Boolean) as string[];
  for (const sdk of roots) {
    const tools = join(sdk, "build-tools");
    if (!existsSync(tools)) continue;
    const newest = readdirSync(tools).filter(d => existsSync(join(tools, d, "aapt2"))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
    if (newest) return join(tools, newest, "aapt2");
  }
  return null;
}

export function apkVersion(file: string, given?: { version?: string; code?: number }): { version: string; code: number } {
  if (given?.version && given.code) return { version: given.version, code: given.code };
  const tool = aapt2();
  if (!tool) throw new Error("no aapt2 to read the APK's version: install Android build-tools or pass --apk-version and --apk-code");
  const info = parseBadging(execFileSync(tool, ["dump", "badging", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  if (!info) throw new Error(`${file} does not read as an APK`);
  return info;
}

export interface Extras {
  android?: { version: string; code: number; url: string; sha256: string };
  cli?: { version: string; url: string; sha256: string };
  docker: string;
}
/** the fields latest.json carries beside its signature (docs/releasing.md, "What latest.json says"): each sha256 is that
 * file's line in SHA256SUMS, whose own hash the signature vouches for */
export function releaseExtras(dir: string, version: string, apk?: { version: string; code: number }): Extras {
  const url = (name: string) => `https://github.com/${DOWNLOADS_REPO}/releases/download/v${version}/${name}`;
  const out: Extras = { docker: `${SERVER_IMAGE}:v${version}` };
  if (apk && existsSync(join(dir, "DuskBot.apk"))) out.android = { ...apk, url: url("DuskBot.apk"), sha256: sha256File(join(dir, "DuskBot.apk")) };
  const cli = `duskbot-${version}.tgz`;
  if (existsSync(join(dir, cli))) out.cli = { version, url: url(cli), sha256: sha256File(join(dir, cli)) };
  return out;
}

/** packs the `duskbot` package (scripts/build-npm-package.mjs) into <dir>/duskbot-<version>.tgz and its stable copy */
export function packCli(dir: string, version: string, run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })): string {
  // npm pack runs in release/npm, so a relative --pack-destination would land under it (release.yml passes "release")
  dir = resolve(dir);
  run(process.execPath, [join(ROOT, "scripts", "build-npm-package.mjs")], ROOT);
  const npmDir = join(ROOT, "release", "npm");
  const pkg = JSON.parse(readFileSync(join(npmDir, "package.json"), "utf8")) as { version: string };
  if (pkg.version !== version) throw new Error(`the built package is ${pkg.version}, not ${version}`);
  mkdirSync(dir, { recursive: true });
  const packed = run("npm", ["pack", "--silent", "--pack-destination", dir], npmDir).trim().split("\n").pop()!;
  const name = `duskbot-${version}.tgz`;
  if (packed !== name) renameSync(join(dir, packed), join(dir, name));
  copyFileSync(join(dir, name), join(dir, "duskbot.tgz"));
  return join(dir, name);
}

function table(version: string, check: Check, sizes: Map<string, number>, log: (line: string) => void) {
  for (const a of releaseAssets(version)) {
    const ok = check.present.some(p => p.name === a.name);
    const size = sizes.get(a.name);
    log(`  ${ok ? "ok     " : "MISSING"} ${a.name.padEnd(42)} ${a.kind.padEnd(9)} ${size ? `${(size / 1048576).toFixed(1).padStart(7)} MB` : "".padStart(10)}  ${a.label}`);
  }
  log(`  ${"docker".padEnd(7)} ${`${SERVER_IMAGE}:v${version}`.padEnd(42)} ${"server".padEnd(9)} ${"".padStart(10)}  Server image (server-image.yml on publish)`);
  for (const name of check.extra) log(`  extra   ${name}`);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    dir: { type: "string" }, "pack-cli": { type: "boolean" }, apk: { type: "string" }, "carry-apk": { type: "boolean" },
    "apk-version": { type: "string" }, "apk-code": { type: "string" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } } });
  const version = positionals[0];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !values.dir) {
    console.error("usage: release-assets.ts <x.y.z> --dir DIR [--pack-cli] [--apk FILE | --carry-apk] [--apk-version V --apk-code N] [--dry-run] [--json]");
    process.exit(2);
  }
  const dir = values.dir, dryRun = values["dry-run"] === true, log = values.json ? (line: string) => console.error(line) : (line: string) => console.log(line);
  mkdirSync(dir, { recursive: true });
  if (values["pack-cli"]) log(`packed ${packCli(dir, version)}`);
  if (values.apk) copyFileSync(values.apk, join(dir, "DuskBot.apk"));
  else if (values["carry-apk"] && !existsSync(join(dir, "DuskBot.apk"))) {
    execFileSync("gh", ["release", "download", "--repo", DOWNLOADS_REPO, "--pattern", "DuskBot.apk", "--dir", dir, "--clobber"], { stdio: "inherit" });
    log(`carried DuskBot.apk forward from ${DOWNLOADS_REPO}'s latest release`);
  }
  const apk = existsSync(join(dir, "DuskBot.apk"))
    ? apkVersion(join(dir, "DuskBot.apk"), { version: values["apk-version"], code: values["apk-code"] ? Number(values["apk-code"]) : undefined })
    : undefined;
  const { sha256sums, releaseManifest } = await import("./release-manifest.ts");
  const sums = sha256sums(dir);
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  const extras = releaseExtras(dir, version, apk);
  const key = process.env.DUSK_RELEASE_SIGNING_KEY;
  const manifest = key ? releaseManifest(sums, version, key, Date.now(), extras)
    : { v: 1, version, sha256sums: createHash("sha256").update(sums).digest("hex"), signature: "(dry run: DUSK_RELEASE_SIGNING_KEY is not set)", ...extras };
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const names = readdirSync(dir).filter(n => statSync(join(dir, n)).isFile());
  const sizes = new Map(names.map(n => [n, statSync(join(dir, n)).size]));
  const check = checkAssets(version, names);
  log(`dusk bot ${version}: ${check.present.length} of ${releaseAssets(version).length} release files in ${dir}${dryRun ? " (dry run, nothing uploaded)" : ""}`);
  table(version, check, sizes, log);
  if (apk) log(`  android ${apk.version} (code ${apk.code})`);
  if (!key) log("  latest.json is unsigned: DUSK_RELEASE_SIGNING_KEY is not set");
  if (values.json) console.log(JSON.stringify({ version, dir, present: check.present.map(a => a.name), missing: check.missing.map(a => a.name), extra: check.extra, extras }, null, 2));
  process.exit(check.missing.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
