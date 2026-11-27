// What each release changed (apps/site/public/landing/releases/changelog.json, written at release time) and the parts of
// latest.json the apps read to say a newer version exists. Both files are optional: a missing or odd one reads as empty.

export const CHANGELOG_URL = "https://dusk.bot/releases/changelog.json";
export const LATEST_URL = "https://dusk.bot/releases/latest.json";
/** always the newest APK: every release carries it forward */
export const LATEST_APK_URL = "https://github.com/DuskBotAI/duskbot-releases/releases/latest/download/DuskBot.apk";

export type ReleaseArea = "desktop" | "phone" | "server" | "cli" | "all";
/** which heading a change sits under in the apps' What's new; a release with none set is one plain list */
export type ReleaseKind = "new" | "better" | "fixed";
/** the small pixel picture beside a change; unset, its kind's */
export type ReleaseIcon = "spark" | "bolt" | "check" | "cloud" | "chat" | "phone" | "file" | "photo" | "key" | "moon" | "eraser" | "bell" | "eye";
export interface ReleaseItem { text: string; area: ReleaseArea; kind?: ReleaseKind; icon?: ReleaseIcon; issue?: number; pr?: number }
export interface Release { version: string; date?: string; title?: string; items: ReleaseItem[] }

const AREAS: readonly ReleaseArea[] = ["desktop", "phone", "server", "cli", "all"];
export const RELEASE_KINDS: readonly ReleaseKind[] = ["new", "better", "fixed"];
export const RELEASE_ICONS: readonly ReleaseIcon[] = ["spark", "bolt", "check", "cloud", "chat", "phone", "file", "photo", "key", "moon", "eraser", "bell", "eye"];
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_RELEASES = 60;
const MAX_ITEMS = 40;

function line(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function count(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

/** the releases a changelog.json body lists, newest first; anything that is not one is dropped */
export function parseChangelog(body: unknown): Release[] {
  const list = (body as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(list)) return [];
  const releases: Release[] = [];
  for (const entry of list.slice(0, MAX_RELEASES)) {
    const version = line((entry as { version?: unknown } | null)?.version, 20);
    if (!version || !VERSION.test(version)) continue;
    const raw = (entry as { items?: unknown }).items;
    const items: ReleaseItem[] = [];
    for (const item of Array.isArray(raw) ? raw.slice(0, MAX_ITEMS) : []) {
      const text = line((item as { text?: unknown } | null)?.text, 300);
      if (!text) continue;
      const area = (item as { area?: unknown }).area;
      const kind = (item as { kind?: unknown }).kind, icon = (item as { icon?: unknown }).icon;
      const issue = count((item as { issue?: unknown }).issue), pr = count((item as { pr?: unknown }).pr);
      items.push({
        text, area: AREAS.includes(area as ReleaseArea) ? area as ReleaseArea : "all",
        ...(RELEASE_KINDS.includes(kind as ReleaseKind) ? { kind: kind as ReleaseKind } : {}),
        ...(RELEASE_ICONS.includes(icon as ReleaseIcon) ? { icon: icon as ReleaseIcon } : {}),
        ...(issue ? { issue } : {}), ...(pr ? { pr } : {}),
      });
    }
    if (!items.length) continue;
    const date = line((entry as { date?: unknown }).date, 10);
    const title = line((entry as { title?: unknown }).title, 120);
    releases.push({ version, ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}), ...(title ? { title } : {}), items });
  }
  return releases.sort((a, b) => compareRelease(b.version, a.version));
}

/** a vs b for plain x.y.z versions; anything else sorts first */
export function compareRelease(a: string, b: string): number {
  const parse = (value: string) => VERSION.test(value) ? value.split(".").map(Number) : [-1, -1, -1];
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}

/** the releases a surface shows, each keeping only its items for that surface (and "all"); empty releases go */
export function releasesFor(releases: readonly Release[], areas: readonly ReleaseArea[]): Release[] {
  return releases.flatMap((release) => {
    const items = release.items.filter((item) => item.area === "all" || areas.includes(item.area));
    return items.length ? [{ ...release, items }] : [];
  });
}

/** the releases after `from` up to and including `to`: what an update from `from` to `to` brought */
export function releasesBetween(releases: readonly Release[], from: string | null, to: string): Release[] {
  return releases.filter((release) => compareRelease(release.version, to) <= 0 && (from === null || compareRelease(release.version, from) > 0));
}

/** latest.json's newer-app parts (the releases track adds them; missing = say nothing) */
export interface LatestFeed { version: string | null; android: { version: string; code: number | null; url: string } | null }

export function parseLatestFeed(body: unknown): LatestFeed {
  const raw = body as { version?: unknown; android?: { version?: unknown; code?: unknown; url?: unknown } } | null;
  const version = typeof raw?.version === "string" && VERSION.test(raw.version) ? raw.version : null;
  const android = raw?.android;
  const androidVersion = typeof android?.version === "string" && VERSION.test(android.version) ? android.version : null;
  const url = typeof android?.url === "string" && /^https:\/\/(github\.com\/DuskBotAI\/|dusk\.bot\/)/.test(android.url) ? android.url : LATEST_APK_URL;
  return { version, android: androidVersion ? { version: androidVersion, code: count(android?.code) ?? null, url } : null };
}

/** whether the phone's own build is older than the newest APK: the build number when both say one, else x.y.z */
export function apkBehind(feed: LatestFeed, own: { version: string; build?: number | null }): boolean {
  if (!feed.android) return false;
  if (feed.android.code !== null && own.build) return feed.android.code > own.build;
  return compareRelease(feed.android.version, own.version) > 0 && VERSION.test(own.version);
}
