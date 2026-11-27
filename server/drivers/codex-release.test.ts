import { describe, expect, it, vi } from "vitest";
import { codexVersionBehind, createCodexReleaseAgeReader, createCodexReleaseReader } from "./codex-release.ts";

describe("Codex stable releases", () => {
  it("compares releases without mistaking newer nightlies or unknown wrappers for old builds", () => {
    for (const version of ["codex-cli 0.154.0", "0.155.0-alpha.16", "0.156.1-beta.1"]) {
      expect(codexVersionBehind(version, "0.156.1")).toBe(true);
    }
    for (const version of ["0.156.1", "0.156.1+build.1", "0.157.0-alpha.1", "1.0.0", "custom nightly", "0.154.0.4"]) {
      expect(codexVersionBehind(version, "0.156.1")).toBe(false);
    }
    expect(codexVersionBehind("0.154.0", "0.157.0-alpha.1")).toBe(false);
  });

  it("shares concurrent checks and refreshes after an hour", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ version: "0.156.1" })));
    const read = createCodexReleaseReader(fetcher, () => now);
    expect(await Promise.all([read(), read()])).toEqual(["0.156.1", "0.156.1"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 3_600_001;
    fetcher.mockResolvedValue(new Response(JSON.stringify({ version: "0.157.0" })));
    expect(await read()).toBe("0.157.0");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails quietly offline and retries after five minutes", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const read = createCodexReleaseReader(fetcher, () => now);
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 300_001;
    fetcher.mockResolvedValue(new Response(JSON.stringify({ version: "0.156.1" })));
    expect(await read()).toBe("0.156.1");
  });

  it.each([{}, { version: "nightly" }, { version: "0.157.0-alpha.1" }])("ignores malformed or prerelease stable metadata: %j", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    expect(await createCodexReleaseReader(fetcher)()).toBeNull();
  });

  it("reads the latest release's publish time from its tarball's Last-Modified", async () => {
    const tarball = "https://registry.npmjs.org/@openai/codex/-/codex-0.172.0.tgz";
    const fetcher = vi.fn<typeof fetch>(async (url, init) => url === tarball && init?.method === "HEAD"
      ? new Response(null, { headers: { "last-modified": "Tue, 24 Nov 2026 00:09:46 GMT" } })
      : new Response(JSON.stringify({ version: "0.172.0", dist: { tarball } })));
    expect(await createCodexReleaseAgeReader(fetcher)()).toEqual({ version: "0.172.0", publishedAt: Date.UTC(2026, 10, 24, 0, 9, 46) });
  });

  it("leaves the publish time unknown for a tarball off the registry or without the header", async () => {
    const offRegistry = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ version: "0.172.0", dist: { tarball: "https://example.test/c.tgz" } })));
    expect(await createCodexReleaseAgeReader(offRegistry)()).toEqual({ version: "0.172.0", publishedAt: null });
    expect(offRegistry).toHaveBeenCalledTimes(1);
    const noHeader = vi.fn<typeof fetch>(async (_url, init) => init?.method === "HEAD" ? new Response(null)
      : new Response(JSON.stringify({ version: "0.172.0", dist: { tarball: "https://registry.npmjs.org/@openai/codex/-/codex-0.172.0.tgz" } })));
    expect(await createCodexReleaseAgeReader(noHeader)()).toEqual({ version: "0.172.0", publishedAt: null });
  });

  it.each([{}, { version: "0.172.0-alpha.1" }, { version: "0.172.0+build" }])("has no release for malformed or prerelease metadata: %j", async (body) => {
    expect(await createCodexReleaseAgeReader(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body))))()).toBeNull();
  });
});
