import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signRelease } from "../apps/cloud-service/src/release-signing.ts";
import { detectInstall, EXIT_UPDATE_AVAILABLE, npmInstallOf, parseUpdateArgs, runUpdate, serverChanges, type UpdateArgs, type UpdateProbes } from "./cli-update.ts";

const pair = generateKeyPairSync("ed25519");
const kid = "rel-test";
const x = pair.publicKey.export({ format: "jwk" }).x!;
const signingKey = `${kid}:${pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;
const FEED = "http://feed.test/releases";
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const tgz = Buffer.from("the 0.2.33 package");
const changelog = {
  v: 1,
  releases: [
    { version: "0.2.34", date: "2026-12-01", items: [{ text: "not out yet", area: "server" }] },
    { version: "0.2.33", date: "2026-11-28", items: [
      { text: "duskbot pair --phone ios makes a phone pairing", area: "cli", issue: 352 },
      { text: "the phone app finds its update", area: "phone", issue: 353 },
      { text: "zip files attach\u001b[31m in chat", area: "all", pr: 400 },
    ] },
    { version: "0.2.32", date: "2026-11-27", items: [{ text: "faster startup", area: "server" }] },
    { version: "0.2.31", date: "2026-11-20", items: [{ text: "already installed", area: "server" }] },
  ],
};

function feed(opts: { sums?: string; cli?: object | null; tamperSums?: boolean; signedBy?: string; changelog?: unknown; served?: Buffer } = {}) {
  const sums = opts.sums ?? `${sha("dmg")}  DuskBot-0.2.33-arm64.dmg\n${sha(tgz)}  duskbot-0.2.33.tgz\n${sha(tgz)}  duskbot.tgz\n`;
  const key = opts.signedBy ?? signingKey;
  const manifest = {
    v: 1, version: "0.2.33", sha256sums: sha(sums),
    signature: signRelease({ kind: "desktop", name: "dusk bot", version: "0.2.33", sha256: sha(sums), signedAt: 1 }, key),
    ...(opts.cli === null ? {} : { cli: opts.cli ?? { version: "0.2.33", url: `${FEED}/0.2.33/duskbot-0.2.33.tgz`, sha256: sha(tgz) } }),
  };
  const files: Record<string, string | Buffer> = {
    [`${FEED}/latest.json`]: JSON.stringify(manifest),
    [`${FEED}/changelog.json`]: JSON.stringify(opts.changelog ?? changelog),
    [`${FEED}/0.2.33/SHA256SUMS`]: opts.tamperSums ? `${sums}${"c".repeat(64)}  duskbot-evil.tgz\n` : sums,
    [`${FEED}/0.2.33/duskbot-0.2.33.tgz`]: opts.served ?? tgz,
    "https://github.com/DuskBotAI/duskbot-releases/releases/download/v0.2.33/duskbot-0.2.33.tgz": opts.served ?? tgz,
  };
  return vi.fn(async (url: string | URL | Request) => {
    const body = files[String(url)];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  });
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function npmRoot() {
  const prefix = mkdtempSync(join(tmpdir(), "dusk-cli-update-"));
  dirs.push(prefix);
  const packageDir = join(prefix, "lib", "node_modules", "duskbot");
  mkdirSync(join(packageDir, "dist-server"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "duskbot", version: "0.2.31" }));
  return { prefix, packageDir, serverRoot: join(packageDir, "dist-server") };
}

function probes(patch: Partial<UpdateProbes> & { markers?: string[] } = {}) {
  const out: string[] = [], err: string[] = [];
  const markers = new Set(patch.markers ?? []);
  const run = vi.fn(async (_file: string, args: string[]) => {
    // a stand-in npm: installs the tarball's version over the old one
    const at = args.indexOf("--prefix");
    if (at >= 0) writeFileSync(join(args[at + 1]!, "lib", "node_modules", "duskbot", "package.json"), JSON.stringify({ name: "duskbot", version: "0.2.33" }));
    return { code: 0, stdout: "", stderr: "" };
  });
  const value: UpdateProbes = {
    current: "0.2.31",
    serverRoot: ["", "srv", "duskbot", "dist-server"].join(sep),
    env: { DUSK_RELEASE_FEED: FEED, DUSK_RELEASE_PUBLIC_KEYS: `${kid}:${x}` },
    platform: "linux", home: "/home/me", isRoot: false, isTTY: false,
    fetch: feed() as unknown as typeof fetch,
    exists: (path) => markers.has(path),
    writable: () => true,
    run,
    confirm: vi.fn(async () => true),
    tmpDir: () => { const dir = mkdtempSync(join(tmpdir(), "dusk-cli-dl-")); dirs.push(dir); return dir; },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    ...patch,
  };
  return { value, out, err, run };
}

const args = (patch: Partial<UpdateArgs> = {}): UpdateArgs => ({ command: "update", check: false, yes: false, json: false, verbose: false, ...patch });

describe("duskbot update arguments", () => {
  it("reads the flags and refuses the rest", () => {
    expect(parseUpdateArgs(["update", "--check", "--json"])).toEqual({ command: "update", check: true, yes: false, json: true, verbose: false });
    expect(parseUpdateArgs(["update", "-y"])).toMatchObject({ yes: true });
    expect(parseUpdateArgs(["version", "--check"])).toMatchObject({ command: "version", check: true });
    expect(parseUpdateArgs(["version", "--yes"])).toEqual({ error: 'unknown argument "--yes"' });
    expect(parseUpdateArgs(["update", "--check", "--yes"])).toHaveProperty("error");
  });

  it("finds the npm prefix the running copy lives under, and refuses an npx cache", () => {
    expect(npmInstallOf(["", "home", "dusk", ".local", "lib", "node_modules", "duskbot", "dist-server"].join(sep), "linux"))
      .toEqual({ prefix: ["", "home", "dusk", ".local"].join(sep), packageDir: ["", "home", "dusk", ".local", "lib", "node_modules", "duskbot"].join(sep), modules: ["", "home", "dusk", ".local", "lib", "node_modules"].join(sep) });
    expect(npmInstallOf(["", "usr", "lib", "node_modules", "duskbot", "dist-server"].join(sep), "linux")?.prefix).toBe(["", "usr"].join(sep));
    expect(npmInstallOf(["", "home", "me", ".npm", "_npx", "abc", "node_modules", "duskbot", "dist-server"].join(sep), "linux")).toBeNull();
    expect(npmInstallOf(["", "work", "app", "node_modules", "duskbot", "dist-server"].join(sep), "linux")).toBeNull();
  });
});

describe("what changed for the server", () => {
  it("keeps server, cli and all items from the versions after this one up to the latest, as plain single lines", () => {
    const changes = serverChanges(changelog, "0.2.31", "0.2.33");
    expect(changes.map(release => release.version)).toEqual(["0.2.33", "0.2.32"]);
    expect(changes[0]!.items).toEqual([
      { text: "duskbot pair --phone ios makes a phone pairing", area: "cli", issue: 352, url: "https://github.com/DuskBotAI/duskbot/issues/352" },
      { text: "zip files attach [31m in chat", area: "all", pr: 400, url: "https://github.com/DuskBotAI/duskbot/pull/400" },
    ]);
  });

  it("says nothing for a missing, empty or odd file", () => {
    for (const body of [null, {}, { releases: [] }, { releases: "x" }, { releases: [{ version: "latest", items: [] }] }]) expect(serverChanges(body, "0.2.31", "0.2.33")).toEqual([]);
  });
});

describe("duskbot update for each install", () => {
  it("tells it is up to date", async () => {
    const p = probes({ current: "0.2.33" });
    expect(await runUpdate(args({ check: true }), p.value)).toBe(0);
    expect(p.out).toEqual(["dusk bot 0.2.33 is up to date."]);
  });

  it("npm --check: the news and the update step, nothing downloaded", async () => {
    const root = npmRoot();
    const p = probes({ serverRoot: root.serverRoot });
    expect(detectInstall(p.value)).toBe("npm");
    expect(await runUpdate(args({ check: true }), p.value)).toBe(EXIT_UPDATE_AVAILABLE);
    expect(p.out.join("\n")).toBe([
      "dusk bot 0.2.33 is out (you have 0.2.31).",
      "",
      "What's new for your server:",
      "  0.2.33",
      "  - duskbot pair --phone ios makes a phone pairing  https://github.com/DuskBotAI/duskbot/issues/352",
      "  - zip files attach [31m in chat  https://github.com/DuskBotAI/duskbot/pull/400",
      "  0.2.32",
      "  - faster startup",
      "Full changelog: https://dusk.bot/changelog",
      "",
      `duskbot update downloads 0.2.33, checks it against the signed release and installs it into ${root.prefix}.`,
    ].join("\n"));
    expect(p.run).not.toHaveBeenCalled();
    expect((p.value.fetch as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]))).toEqual([`${FEED}/latest.json`, `${FEED}/changelog.json`]);
  });

  it("npm --yes: downloads, checks and installs into the prefix it runs from", async () => {
    const root = npmRoot();
    const p = probes({ serverRoot: root.serverRoot });
    expect(await runUpdate(args({ yes: true }), p.value)).toBe(0);
    expect(p.run).toHaveBeenCalledExactlyOnceWith("npm", ["install", "--global", "--no-fund", "--no-audit", "--prefix", root.prefix, expect.stringMatching(/duskbot-0\.2\.33\.tgz$/)]);
    expect(JSON.parse(readFileSync(join(root.packageDir, "package.json"), "utf8")).version).toBe("0.2.33");
    expect(p.out.slice(-2)).toEqual(["Installed dusk bot 0.2.33.", "If the server is running, stop it and start it again to use the new version."]);
  });

  it("npm: names the service restart when duskbot service install made one", async () => {
    const root = npmRoot();
    const p = probes({ serverRoot: root.serverRoot, markers: ["/etc/systemd/system/duskbot.service"] });
    expect(await runUpdate(args({ yes: true }), p.value)).toBe(0);
    expect(p.out.at(-1)).toBe("Restart the server to use it: sudo systemctl restart duskbot");
  });

  it("npm: asks first on a terminal, and only looks without one", async () => {
    const root = npmRoot();
    const declined = probes({ serverRoot: root.serverRoot, isTTY: true, confirm: vi.fn(async () => false) });
    expect(await runUpdate(args(), declined.value)).toBe(EXIT_UPDATE_AVAILABLE);
    expect(declined.value.confirm).toHaveBeenCalledWith("Install dusk bot 0.2.33 now?");
    expect(declined.out.at(-1)).toBe("Nothing was changed.");
    const piped = probes({ serverRoot: root.serverRoot });
    expect(await runUpdate(args(), piped.value)).toBe(EXIT_UPDATE_AVAILABLE);
    expect(piped.out.at(-1)).toBe("Run duskbot update --yes to install it.");
    for (const p of [declined, piped]) expect(p.run).not.toHaveBeenCalled();
  });

  it("npm: refuses a package whose bytes are not the signed ones, and installs nothing", async () => {
    const root = npmRoot();
    const p = probes({ serverRoot: root.serverRoot, fetch: feed({ served: Buffer.from("something else") }) as unknown as typeof fetch });
    expect(await runUpdate(args({ yes: true, verbose: true }), p.value)).toBe(1);
    expect(p.err[0]).toBe("The downloaded server package doesn't match the signed release, so nothing was installed.");
    expect(p.err[1]).toMatch(/^cause: sha256 [a-f0-9]{64}, expected/);
    expect(p.run).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(root.packageDir, "package.json"), "utf8")).version).toBe("0.2.31");
  });

  it("npm: refuses checksums the signature does not vouch for, and a listed hash that disagrees with them", async () => {
    const root = npmRoot();
    const tampered = probes({ serverRoot: root.serverRoot, fetch: feed({ tamperSums: true }) as unknown as typeof fetch });
    expect(await runUpdate(args({ yes: true }), tampered.value)).toBe(1);
    expect(tampered.err).toEqual(["The release checksums don't match the signed release, so nothing was installed."]);
    const listed = probes({ serverRoot: root.serverRoot, fetch: feed({ cli: { version: "0.2.33", url: `${FEED}/0.2.33/duskbot-0.2.33.tgz`, sha256: "b".repeat(64) } }) as unknown as typeof fetch });
    expect(await runUpdate(args({ yes: true }), listed.value)).toBe(1);
    expect(listed.err).toEqual(["The release names a server package that doesn't match its checksums, so nothing was installed."]);
    for (const p of [tampered, listed]) expect(p.run).not.toHaveBeenCalled();
  });

  it("npm: an older release without a cli entry uses the versioned GitHub file, and says plainly when there is none", async () => {
    const root = npmRoot();
    const fallback = probes({ serverRoot: root.serverRoot, fetch: feed({ cli: null }) as unknown as typeof fetch });
    expect(await runUpdate(args({ yes: true }), fallback.value)).toBe(0);
    expect((fallback.value.fetch as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]))).toContain("https://github.com/DuskBotAI/duskbot-releases/releases/download/v0.2.33/duskbot-0.2.33.tgz");
    const missing = probes({ serverRoot: npmRoot().serverRoot, fetch: feed({ cli: null, sums: `${sha("dmg")}  DuskBot-0.2.33-arm64.dmg\n` }) as unknown as typeof fetch });
    expect(await runUpdate(args({ yes: true }), missing.value)).toBe(1);
    expect(missing.err).toEqual(["The server package for 0.2.33 isn't published, so nothing was installed. See https://dusk.bot/docs/your-own-server"]);
  });

  it("npm: a prefix it cannot write names the command that can", async () => {
    const p = probes({ serverRoot: npmRoot().serverRoot, writable: () => false });
    expect(await runUpdate(args({ yes: true }), p.value)).toBe(1);
    expect(p.err[0]).toMatch(/needs more rights .* sudo "\$\(command -v duskbot\)" update --yes$/);
  });

  it("refuses a manifest no pinned key signed", async () => {
    const other = generateKeyPairSync("ed25519");
    const p = probes({ fetch: feed({ signedBy: `${kid}:${other.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}` }) as unknown as typeof fetch });
    expect(await runUpdate(args({ check: true }), p.value)).toBe(1);
    expect(p.err).toEqual(["The release information from dusk.bot didn't pass its signature check, so nothing was changed."]);
  });

  it("trusts extra keys only with a feed of its own", async () => {
    const p = probes({ env: { DUSK_RELEASE_PUBLIC_KEYS: `${kid}:${x}` }, fetch: vi.fn(async (url: string | URL | Request) => feed()(String(url).replace("https://dusk.bot/releases", FEED))) as unknown as typeof fetch });
    expect(await runUpdate(args({ check: true }), p.value)).toBe(1);
    expect(p.err[0]).toMatch(/signature check/);
  });

  it("link: explains it updates itself, and starts its updater only as root with --yes", async () => {
    const markers = ["/var/lib/duskbot-link/linked", "/etc/systemd/system/duskbot-server-update.timer"];
    const serverRoot = ["", "home", "dusk", ".local", "lib", "node_modules", "duskbot", "dist-server"].join(sep);
    const user = probes({ serverRoot, markers });
    expect(detectInstall(user.value)).toBe("link");
    expect(await runUpdate(args({ yes: true }), user.value)).toBe(EXIT_UPDATE_AVAILABLE);
    expect(user.out.slice(-2)).toEqual([
      "This server was set up from the dusk bot app and installs new versions itself while no bot is working. It looks every 15 minutes.",
      "To look for it now instead of waiting: sudo systemctl start duskbot-server-update.service",
    ]);
    expect(user.run).not.toHaveBeenCalled();
    const root = probes({ serverRoot, markers, isRoot: true });
    expect(await runUpdate(args({ yes: true }), root.value)).toBe(0);
    expect(root.run).toHaveBeenCalledExactlyOnceWith("systemctl", ["start", "--no-block", "duskbot-server-update.service"]);
  });

  it.each([
    ["docker", ["/.dockerenv"], {}, "This server runs in a container and is updated from the host. In the folder with its compose file, run: docker compose pull dusk && docker compose up -d"],
    ["docker", ["/.dockerenv"], { DUSK_COMPOSE_IMAGE: "ghcr.io/duskbotai/duskbot:v0.2.31" }, "This server runs in a container pinned to ghcr.io/duskbotai/duskbot:v0.2.31. On the host, set DUSK_IMAGE to ghcr.io/duskbotai/duskbot:v0.2.33, then run: docker compose up -d"],
    ["podman", ["/run/.containerenv"], {}, "This server runs in a container and is updated from the host. In the folder with its compose file, run: podman compose pull dusk && podman compose up -d"],
    ["desktop", [], { DUSK_DESKTOP_PARENT: "1" }, "The dusk bot app runs this server and updates it. Update the app, or get it from https://dusk.bot/download"],
    ["managed", [], { DUSK_CLOUD_ROLE: "home" }, "dusk cloud keeps this server up to date for you. Nothing to do."],
    ["git", [join(["", "srv", "duskbot", "dist-server"].join(sep), "..", ".git")], {}, `This server runs from a git checkout. In ${["", "srv", "duskbot"].join(sep)}, run: git pull && pnpm install && pnpm build:server, then restart the server.`],
    ["unknown", [], {}, "Get the server package from https://github.com/DuskBotAI/duskbot/releases/tag/v0.2.33 and follow https://dusk.bot/docs/your-own-server"],
  ] as const)("%s: shows the news and the one step that updates it, and changes nothing", async (kind, markers, env, step) => {
    const p = probes({ markers: [...markers], env: { DUSK_RELEASE_FEED: FEED, DUSK_RELEASE_PUBLIC_KEYS: `${kid}:${x}`, ...env } });
    expect(detectInstall(p.value)).toBe(kind);
    expect(await runUpdate(args({ yes: true }), p.value)).toBe(EXIT_UPDATE_AVAILABLE);
    expect(p.out[0]).toBe("dusk bot 0.2.33 is out (you have 0.2.31).");
    expect(p.out).toContain("  - duskbot pair --phone ios makes a phone pairing  https://github.com/DuskBotAI/duskbot/issues/352");
    expect(p.out.at(-1)).toBe(step);
    expect(p.run).not.toHaveBeenCalled();
  });

  it("--json prints one document; a missing changelog only links the page", async () => {
    const p = probes({ fetch: feed({ changelog: "nope" }) as unknown as typeof fetch, markers: ["/.dockerenv"] });
    expect(await runUpdate(args({ check: true, json: true }), p.value)).toBe(EXIT_UPDATE_AVAILABLE);
    expect(p.out).toHaveLength(1);
    expect(JSON.parse(p.out[0]!)).toEqual({
      current: "0.2.31", latest: "0.2.33", available: true, install: "docker", changes: [], changelog: "https://dusk.bot/changelog",
      action: { kind: "command", command: "docker compose pull dusk && docker compose up -d", message: expect.stringContaining("docker compose pull dusk") },
    });
  });

  it("says plainly when the feed cannot be reached", async () => {
    const p = probes({ fetch: vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    expect(await runUpdate(args({ check: true }), p.value)).toBe(1);
    expect(p.err).toEqual(["Couldn't reach dusk.bot. Check this machine's internet connection and try again."]);
  });

  it("version prints the version and the install without the network", async () => {
    const root = npmRoot();
    const p = probes({ serverRoot: root.serverRoot, fetch: vi.fn() as unknown as typeof fetch });
    expect(await runUpdate(args({ command: "version" }), p.value)).toBe(0);
    expect(p.out).toEqual([`dusk bot 0.2.31 (npm, ${root.prefix})`]);
    expect(p.value.fetch).not.toHaveBeenCalled();
  });
});
