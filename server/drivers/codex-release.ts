// Release freshness is independent of account-specific model availability.
function parseCodexReleaseVersion(value: string): { parts: number[]; prerelease: boolean } | null {
  const match = /^(?:.*\bcodex-cli\s+)?v?(\d+)\.(\d+)\.(\d+)(-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i.exec(value.trim());
  return match ? { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) } : null;
}

export function codexVersionBehind(installed: string, latest: string): boolean {
  const a = parseCodexReleaseVersion(installed);
  const b = parseCodexReleaseVersion(latest);
  if (!a || !b || b.prerelease) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i];
  }
  return a.prerelease;
}

export function createCodexReleaseReader(fetchImpl: typeof fetch = fetch, now = Date.now) {
  let cached: Promise<string | null> | undefined;
  let expires = 0;
  return (): Promise<string | null> => {
    if (cached && now() < expires) return cached;
    expires = now() + 60 * 60 * 1000;
    cached = (async () => {
      try {
        const response = await fetchImpl("https://registry.npmjs.org/@openai/codex/latest", {
          signal: AbortSignal.timeout(3000),
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("Release lookup failed");
        const payload = await response.json() as { version?: unknown };
        const version = typeof payload.version === "string" ? payload.version : "";
        const parsed = parseCodexReleaseVersion(version);
        if (!parsed || parsed.prerelease) throw new Error("Invalid stable release");
        return version;
      } catch {
        // Offline checks must not make an otherwise usable engine unavailable.
        expires = now() + 5 * 60 * 1000;
        return null;
      }
    })();
    return cached;
  };
}

export const readLatestCodexRelease = createCodexReleaseReader();

export interface CodexRelease {
  version: string;
  /** null when the registry does not say */
  publishedAt: number | null;
}

/** The latest stable release and when it was published. The registry's small per-version document carries no publish
 * time (only the 20 MB full one does), so it comes from the tarball's Last-Modified, which npm sets at publish. */
export function createCodexReleaseAgeReader(fetchImpl: typeof fetch = fetch, now = Date.now) {
  let cached: Promise<CodexRelease | null> | undefined;
  let expires = 0;
  return (): Promise<CodexRelease | null> => {
    if (cached && now() < expires) return cached;
    expires = now() + 60 * 60 * 1000;
    cached = (async () => {
      try {
        const response = await fetchImpl("https://registry.npmjs.org/@openai/codex/latest", {
          signal: AbortSignal.timeout(5000),
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("Release lookup failed");
        const payload = await response.json() as { version?: unknown; dist?: { tarball?: unknown } };
        const version = typeof payload.version === "string" ? payload.version : "";
        const parsed = parseCodexReleaseVersion(version);
        if (!parsed || parsed.prerelease || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid stable release");
        const tarball = typeof payload.dist?.tarball === "string" ? payload.dist.tarball : "";
        let publishedAt: number | null = null;
        if (tarball.startsWith("https://registry.npmjs.org/")) {
          const head = await fetchImpl(tarball, { method: "HEAD", signal: AbortSignal.timeout(5000) }).catch(() => null);
          const stamp = head?.ok ? Date.parse(head.headers.get("last-modified") ?? "") : Number.NaN;
          publishedAt = Number.isFinite(stamp) ? stamp : null;
        }
        return { version, publishedAt };
      } catch {
        expires = now() + 5 * 60 * 1000;
        return null;
      }
    })();
    return cached;
  };
}

export const readLatestCodexReleaseAge = createCodexReleaseAgeReader();
