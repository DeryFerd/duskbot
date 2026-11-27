// What's new: changelog.json read for this page, and the one quiet line after an update. The desktop page asks its server
// (a page can't read dusk.bot itself); the phone app reads dusk.bot natively and falls back to its server. Missing = empty.
import { useEffect, useState } from "react";

import { api } from "@/state/store";
import { CHANGELOG_URL, LATEST_URL, RELEASE_KINDS, compareRelease, parseChangelog, parseLatestFeed, releasesBetween, releasesFor, type LatestFeed, type Release, type ReleaseArea, type ReleaseItem, type ReleaseKind } from "../../shared/release-notes";

export type { LatestFeed, Release, ReleaseArea, ReleaseIcon, ReleaseItem, ReleaseKind } from "../../shared/release-notes";

/** what each surface shows: the desktop app carries its own server, the phone talks to one */
export const DESKTOP_AREAS: readonly ReleaseArea[] = ["desktop", "server", "cli"];
export const PHONE_AREAS: readonly ReleaseArea[] = ["phone", "server"];

const readDirect = async (fetchImpl: typeof fetch, url: string) => {
  const response = await fetchImpl(url, { cache: "no-store", headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
};

let releasesRead: Promise<Release[]> | null = null;

/** every release with notes, newest first; [] when there is no changelog or it can't be read */
export function loadReleases(options: { native?: boolean; fetch?: typeof fetch } = {}): Promise<Release[]> {
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const viaServer = () => api<{ releases?: unknown }>("/api/updates/changelog", { background: true, timeoutMs: 15_000 }).then(parseChangelog);
  const direct = () => readDirect(fetchImpl, CHANGELOG_URL).then(parseChangelog);
  releasesRead ??= (options.native ? direct().catch(viaServer) : viaServer())
    .catch(() => [] as Release[])
    .then((list) => { if (!list.length) releasesRead = null; return list; });
  return releasesRead;
}

export function resetReleasesForTests() { releasesRead = null; }

/** the releases this surface shows (null while reading) */
export function useReleases(areas: readonly ReleaseArea[], options: { native?: boolean; enabled?: boolean } = {}): Release[] | null {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const enabled = options.enabled !== false;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadReleases({ native: options.native }).then((list) => { if (active) setReleases(list); });
    return () => { active = false; };
  }, [enabled, options.native]);
  return releases ? releasesFor(releases, areas) : null;
}

/** latest.json's newer-app parts; null when it can't be read (only the phone app reads it, natively) */
export async function loadLatestFeed(fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<LatestFeed | null> {
  try {
    const body = await readDirect(fetchImpl, LATEST_URL);
    return body ? parseLatestFeed(body) : null;
  } catch {
    return null;
  }
}

const seenKey = (surface: string) => `dusk-whats-new:${surface}`;

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/**
 * The version this surface ran before, when this launch is the first of a newer one; null otherwise (a first install
 * says nothing). Remembers `current` either way, so the line comes once per update.
 */
export function updatedFrom(surface: string, current: string, store: Storage | null = storage()): string | null {
  if (!/^\d+\.\d+\.\d+$/.test(current) || !store) return null;
  let before: string | null = null;
  try { before = store.getItem(seenKey(surface)); } catch { return null; }
  if (before === current) return null;
  try { store.setItem(seenKey(surface), current); } catch { /* says it again next launch */ }
  return before && compareRelease(current, before) > 0 ? before : null;
}

const launches = new Map<string, string | null>();

/** updatedFrom, asked once per page load: a second ask (React's strict mode runs effects twice) gets the same answer */
export function updatedThisLaunch(surface: string, current: string): string | null {
  if (!launches.has(surface)) launches.set(surface, updatedFrom(surface, current));
  return launches.get(surface) ?? null;
}

export function resetLaunchesForTests() { launches.clear(); }

/** the notes an update from `from` to `to` brought this surface (only `to`'s when the version before is unknown); empty when
 * the changelog has none */
export function notesForUpdate(releases: readonly Release[], areas: readonly ReleaseArea[], from: string | null, to: string): Release[] {
  const between = releasesBetween(releasesFor(releases, areas), from, to);
  return dedupeNotes(from ? between : between.filter((release) => release.version === to));
}

/** the same line written in two releases shows once, under the newest (releases come newest first) */
function dedupeNotes(releases: readonly Release[]): Release[] {
  const seen = new Set<string>();
  return releases
    .map((release) => ({ ...release, items: release.items.filter((item) => {
      const key = item.text.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }) }))
    .filter((release) => release.items.length > 0);
}

/** What's new opens on the release whose last number is a multiple of this (0.2.35, 0.2.40), or on the first update past one */
export const WHATS_NEW_EVERY = 5;

/** whether going from `from` to `to` reaches a version that is a multiple of WHATS_NEW_EVERY (a new minor starts at .0, one) */
export function crossesMilestone(from: string, to: string): boolean {
  const [fromMajor, fromMinor, fromPatch] = from.split(".").map(Number) as [number, number, number];
  const [toMajor, toMinor, toPatch] = to.split(".").map(Number) as [number, number, number];
  if (compareRelease(to, from) <= 0) return false;
  if (fromMajor !== toMajor || fromMinor !== toMinor) return true;
  return Math.floor(toPatch / WHATS_NEW_EVERY) > Math.floor(fromPatch / WHATS_NEW_EVERY);
}

export interface PendingUpdate { from: string | null; to: string }

const pendingKey = (surface: string) => `dusk-whats-new:pending:${surface}`;
const toldKey = (surface: string) => `dusk-whats-new:told:${surface}`;
const digestKey = (surface: string) => `dusk-whats-new:digest:${surface}`;
const isVersion = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);

interface Digest { from: string | null; last: string | null }

function readDigest(store: Storage, surface: string): Digest {
  try {
    const raw = JSON.parse(store.getItem(digestKey(surface)) ?? "null") as { from?: unknown; last?: unknown } | null;
    return { from: isVersion(raw?.from) ? raw.from : null, last: isVersion(raw?.last) ? raw.last : null };
  } catch {
    return { from: null, last: null };
  }
}

/**
 * The update whose notes this surface still owes. An update to `updated` (from `before`) owes one when it reaches a
 * multiple of WHATS_NEW_EVERY, as one update from the version this surface ran when it last showed What's new; the others
 * owe nothing. Null on a fresh install and once the notes were shown or had none.
 */
export function updateToTell(surface: string, updated: string | null, before: string | null, store: Storage | null = storage()): PendingUpdate | null {
  if (!store) return null;
  try {
    const told = store.getItem(toldKey(surface));
    if (isVersion(updated) && updated !== told) {
      const digest = readDigest(store, surface);
      if (digest.last !== updated) {
        const next: Digest = { from: digest.from ?? (isVersion(before) ? before : null), last: updated };
        store.setItem(digestKey(surface), JSON.stringify(next));
        if (isVersion(before) && crossesMilestone(before, updated)) store.setItem(pendingKey(surface), JSON.stringify({ from: next.from, to: updated }));
      }
    }
    const pending = JSON.parse(store.getItem(pendingKey(surface)) ?? "null") as { from?: unknown; to?: unknown } | null;
    if (!pending || !isVersion(pending.to) || pending.to === told) return null;
    return { from: isVersion(pending.from) ? pending.from : null, to: pending.to };
  } catch {
    return null;
  }
}

/** that update's notes were shown (or it has none to show): it is not asked again, and the next one's notes start after it */
export function updateTold(surface: string, version: string, store: Storage | null = storage()): void {
  try {
    store?.setItem(toldKey(surface), version);
    store?.removeItem(pendingKey(surface));
    store?.setItem(digestKey(surface), JSON.stringify({ from: null, last: version }));
  } catch { /* asks again next launch */ }
}

export const NOTES_SHOWN_FIRST = 5;

export interface NoteGroup { kind: ReleaseKind | null; items: ReleaseItem[] }

/** every change the releases list, newest release first, in the order they were written */
export function changesIn(releases: readonly Release[]): ReleaseItem[] {
  return releases.flatMap((release) => release.items);
}

/** changes under New, Better and Fixed, each in its written order; one unheaded group when none says which it is */
export function groupChanges(items: readonly ReleaseItem[]): NoteGroup[] {
  if (!items.some((item) => item.kind)) return items.length ? [{ kind: null, items: [...items] }] : [];
  return RELEASE_KINDS.flatMap((kind) => {
    const inKind = items.filter((item) => (item.kind ?? "better") === kind);
    return inKind.length ? [{ kind, items: inKind }] : [];
  });
}
