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
  return from ? between : between.filter((release) => release.version === to);
}

export interface PendingUpdate { from: string | null; to: string }

const pendingKey = (surface: string) => `dusk-whats-new:pending:${surface}`;
const toldKey = (surface: string) => `dusk-whats-new:told:${surface}`;
const isVersion = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);

/**
 * The update whose notes this surface still owes: the one it was just updated to (`updated`, from the version it ran
 * before), or one an earlier launch could not show. Null on a fresh install and once that version's notes were shown.
 */
export function updateToTell(surface: string, updated: string | null, before: string | null, store: Storage | null = storage()): PendingUpdate | null {
  if (!store) return null;
  try {
    const told = store.getItem(toldKey(surface));
    if (isVersion(updated) && updated !== told) store.setItem(pendingKey(surface), JSON.stringify({ from: isVersion(before) ? before : null, to: updated }));
    const pending = JSON.parse(store.getItem(pendingKey(surface)) ?? "null") as { from?: unknown; to?: unknown } | null;
    if (!pending || !isVersion(pending.to) || pending.to === told) return null;
    return { from: isVersion(pending.from) ? pending.from : null, to: pending.to };
  } catch {
    return null;
  }
}

/** that update's notes were shown (or it has none to show): it is not asked again */
export function updateTold(surface: string, version: string, store: Storage | null = storage()): void {
  try {
    store?.setItem(toldKey(surface), version);
    store?.removeItem(pendingKey(surface));
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
