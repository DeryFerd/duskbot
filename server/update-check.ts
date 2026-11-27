import { createPublicKey, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";

import { CHANGELOG_URL, parseChangelog, type Release } from "../shared/release-notes.ts";
import type { InstallKind, UpdateCheck } from "../shared/server-update.ts";
export type { InstallKind, UpdateCheck } from "../shared/server-update.ts";

export const OFFICIAL_SERVER_IMAGE = "ghcr.io/duskbotai/duskbot";
export function tracksOfficialLatest(image: string | undefined): boolean {
  return image === OFFICIAL_SERVER_IMAGE || image === `${OFFICIAL_SERVER_IMAGE}:latest`;
}

/** written by apps/link-service/install.sh once a server is linked; its duskbot-server-update.timer installs new builds */
export const LINKED_MARKER = "/var/lib/duskbot-link/linked";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/DuskBotAI/duskbot/releases/latest";

export function installKind(input: {
  desktopManaged: boolean;
  managed: boolean;
  serverRoot: string;
  exists?: (path: string) => boolean;
}): InstallKind {
  const exists = input.exists ?? existsSync;
  if (input.desktopManaged) return "desktop";
  if (input.managed) return "managed";
  if (exists("/.dockerenv")) return "docker";
  if (exists("/run/.containerenv")) return "podman";
  if (input.serverRoot.split(sep).includes("node_modules")) return "npm";
  if (exists(join(input.serverRoot, "..", ".git"))) return "git";
  return "unknown";
}

/** the signed desktop release manifest: `{ v: 1, signature: "r1.<kid>.<manifest>.<sig>" }`, written by scripts/release-manifest.ts */
export const DESKTOP_MANIFEST_URL = "https://dusk.bot/releases/latest.json";
export const DESKTOP_DOWNLOAD_URL = "https://dusk.bot/download";

/** CI's release keys (apps/cloud-service/src/release-signing.ts pins the same ones; a test keeps them equal) */
export const DESKTOP_RELEASE_KEYS: readonly { kid: string; x: string }[] = [
  { kid: "rel-2026-11", x: "wtwZypDwVPBXZ25XsZOVpd0PZPBbVMhugheUj5_NLIM" },
];

/** the version a manifest vouches for and the sha256 of that release's SHA256SUMS, or null when it is not a desktop release signed by a pinned key */
export function verifiedDesktopRelease(body: unknown, keys: readonly { kid: string; x: string }[] = DESKTOP_RELEASE_KEYS): { version: string; sha256: string } | null {
  const signature = body && typeof body === "object" ? (body as { signature?: unknown }).signature : undefined;
  if (typeof signature !== "string") return null;
  const parts = signature.trim().split(".");
  if (parts.length !== 4 || parts[0] !== "r1" || !/^[A-Za-z0-9_-]+$/.test(parts[2]!) || !/^[A-Za-z0-9_-]+$/.test(parts[3]!)) return null;
  const key = keys.find((item) => item.kid === parts[1]);
  if (!key) return null;
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
    if (!verify(null, Buffer.from(parts.slice(0, 3).join(".")), publicKey, Buffer.from(parts[3]!, "base64url"))) return null;
    const manifest = JSON.parse(Buffer.from(parts[2]!, "base64url").toString("utf8")) as { v?: unknown; kind?: unknown; version?: unknown; sha256?: unknown };
    return manifest.v === 1 && manifest.kind === "desktop" && typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version)
      && typeof manifest.sha256 === "string" && /^[a-f0-9]{64}$/.test(manifest.sha256) ? { version: manifest.version, sha256: manifest.sha256 } : null;
  } catch {
    return null;
  }
}

/** the version a manifest vouches for, or null when it is not a desktop release signed by a pinned key */
export function verifiedDesktopVersion(body: unknown, keys: readonly { kid: string; x: string }[] = DESKTOP_RELEASE_KEYS): string | null {
  return verifiedDesktopRelease(body, keys)?.version ?? null;
}

/** a > b for plain x.y.z versions; anything else is never newer */
export function newerVersion(a: string, b: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const left = parse(a), right = parse(b);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return false;
}

const RELEASE_CHECK_TTL_MS = 60 * 60_000;
let desktopCache: { at: number; latest: string | null } | null = null;

export function createUpdateChecker(options: {
  current: string;
  install: InstallKind;
  fetch?: typeof fetch;
  now?: () => number;
  manifestUrl?: string;
  keys?: readonly { kid: string; x: string }[];
  composeImage?: string;
  releaseImage?: string;
  /** a server the link service installed: it updates itself, so no restart is asked for */
  linked?: boolean;
}) {
  const now = options.now ?? Date.now;
  let release: { expires: number; result: Promise<string> } | undefined;
  function stableRelease() {
    if (release && release.expires > now()) return release.result;
    const result = (options.fetch ?? fetch)(LATEST_RELEASE_URL, {
      redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/vnd.github+json" },
    }).then(async response => {
      if (!response.ok) throw new Error(`GitHub releases answered ${response.status}. Try again later.`);
      const body = await response.json() as { tag_name?: unknown; draft?: unknown; prerelease?: unknown } | null;
      const tag = typeof body?.tag_name === "string" && /^v(\d+\.\d+\.\d+)$/.exec(body.tag_name);
      if (!tag || body.draft !== false || body.prerelease !== false) throw new Error("GitHub did not return a stable dusk bot release.");
      return tag[1]!;
    }).catch(error => { release = undefined; throw error; });
    release = { expires: now() + RELEASE_CHECK_TTL_MS, result };
    return result;
  }
  return async function check(): Promise<UpdateCheck> {
    const base: UpdateCheck = { current: options.current, install: options.install, available: false };
    const image = options.composeImage;
    const official = image ? /^ghcr\.io\/duskbotai\/duskbot(?::[\w][\w.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/.test(image) : options.releaseImage === OFFICIAL_SERVER_IMAGE;
    if (options.install === "docker" && official) {
      const latest = await stableRelease();
      const result = { ...base, latest, available: newerVersion(latest, options.current),
        releaseUrl: `https://github.com/DuskBotAI/duskbot/releases/tag/v${latest}` };
      if (!image) return result;
      return tracksOfficialLatest(image)
        ? { ...result, command: "docker compose pull dusk && docker compose up -d" }
        : { ...result, pinned: image };
    }
    if (options.install !== "desktop" && options.install !== "npm") return base;
    if (!desktopCache || now() - desktopCache.at >= RELEASE_CHECK_TTL_MS) {
      const response = await (options.fetch ?? fetch)(options.manifestUrl ?? DESKTOP_MANIFEST_URL, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
      if (response.status === 404) desktopCache = { at: now(), latest: null };
      else if (!response.ok) throw new Error(`the release manifest answered ${response.status}`);
      else desktopCache = { at: now(), latest: verifiedDesktopVersion(await response.json().catch(() => null), options.keys) };
    }
    const latest = desktopCache.latest;
    // an npm (or link) install has one updater for every way it was installed: `duskbot update` on that machine
    if (options.install === "npm") {
      if (!latest) return base;
      return newerVersion(latest, options.current)
        ? { ...base, latest, available: true, releaseUrl: `https://github.com/DuskBotAI/duskbot/releases/tag/v${latest}`, command: "duskbot update", restart: !options.linked }
        : { ...base, latest };
    }
    return latest && newerVersion(latest, options.current) ? { ...base, latest, available: true, releaseUrl: DESKTOP_DOWNLOAD_URL } : base;
  };
}

export function resetDesktopUpdateCacheForTests() { desktopCache = null; }

/** changelog.json read through this server (a page can't read dusk.bot itself), kept an hour; a missing or broken file is
 * no releases, and a failed read keeps the last good list */
export function createChangelogReader(options: { fetch?: typeof fetch; now?: () => number; url?: string } = {}) {
  const now = options.now ?? Date.now;
  let cached: { at: number; releases: Release[] } | null = null;
  let reading: Promise<Release[]> | null = null;
  return function releases(): Promise<Release[]> {
    if (cached && now() - cached.at < RELEASE_CHECK_TTL_MS) return Promise.resolve(cached.releases);
    reading ??= (options.fetch ?? fetch)(options.url ?? CHANGELOG_URL, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } })
      .then(async (response) => {
        if (response.status === 404) return [];
        if (!response.ok) throw new Error(`the changelog answered ${response.status}`);
        return parseChangelog(await response.json().catch(() => null));
      })
      .then((list) => { cached = { at: now(), releases: list }; return list; }, () => cached?.releases ?? [])
      .finally(() => { reading = null; });
    return reading;
  };
}
