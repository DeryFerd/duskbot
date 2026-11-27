// runs the update code of releases that can't update themselves on Windows and Linux (their tags' own files, from git)
// against a release feed, and fails unless each still names the newest release and a link to its installer.
//
//   node --experimental-strip-types scripts/check-old-updaters.ts               # dusk.bot as it is now (GETs and HEADs only)
//   node --experimental-strip-types scripts/check-old-updaters.ts --feed <dir>  # <dir>/latest.json, <dir>/<version>/SHA256SUMS
//                                                                                 # and its installers, before they are published
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

export const OLD_RELEASES = ["0.2.15", "0.2.17"];
const FILES = ["electron/app-update.mjs", "electron/app-update-download.mjs", "electron/update-notice.mjs", "server/update-check.ts"];

type Fetch = typeof fetch;
interface Finding { release: string; platform: string; ok: boolean; says: string }

/** the feed at `dir` as dusk.bot serves it, on 127.0.0.1; every https url is answered from it */
async function localFeed(dir: string) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/releases\//, "");
    const file = join(dir, path);
    if (!path || path.includes("..") || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200);
    res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const fetchImpl: Fetch = (url, init) => {
    const at = new URL(String(url));
    return fetch(`http://127.0.0.1:${port}${at.hostname === "dusk.bot" ? at.pathname : "/github"}`, init);
  };
  return { fetchImpl, close: () => server.close() };
}

export async function checkOldUpdaters({ repo, fetchImpl, releases = OLD_RELEASES }: { repo: string; fetchImpl: Fetch; releases?: string[] }) {
  const work = mkdtempSync(join(tmpdir(), "old-updaters-"));
  const findings: Finding[] = [];
  try {
    for (const release of releases) {
      const root = join(work, release);
      for (const file of FILES) {
        try {
          const text = execFileSync("git", ["show", `v${release}:${file}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), text);
        } catch { /* this release did not have it */ }
      }
      const checker = await import(join(root, "server/update-check.ts"));
      const answer = await checker.createUpdateChecker({ current: release, install: "desktop", fetch: fetchImpl })();
      const notice = await import(join(root, "electron/update-notice.mjs"));
      const told: string[] = [];
      await notice.createUpdateNotice({ request: async () => new Response(JSON.stringify(answer)), notify: ({ title }: { title: string }) => told.push(title), open: () => {}, memory: { read: () => null, write: () => {} } }).check();
      findings.push({ release, platform: "notification", ok: told.length === 1, says: told[0] ?? `no notification (${JSON.stringify(answer)})` });
      if (!existsSync(join(root, "electron/app-update-download.mjs"))) continue;
      const updater = await import(join(root, "electron/app-update.mjs"));
      for (const [platform, appImage] of [["win32", false], ["linux", true], ["linux", false]] as const) {
        const failures: string[] = [];
        const dir = mkdtempSync(join(work, "dir-"));
        const app = updater.createAppUpdater({ current: release, arch: "x64", dir, installs: false, platform, appImage, fetchImpl, fallback: { check: async () => null }, onFailed: (message: string) => failures.push(message) });
        await app.check();
        const manual = app.state().manual as { version: string; url: string } | null;
        const named = `${platform}${platform === "linux" ? (appImage ? " AppImage" : " deb") : ""}`;
        findings.push({ release, platform: named, ok: Boolean(manual && manual.version === answer.latest && /^https:\/\/(dusk\.bot|github\.com)\/.+\.(exe|AppImage|deb)$/.test(manual.url)), says: manual ? `${manual.version} ${manual.url}` : `nothing to offer (${failures.join("; ") || "no failure"})` });
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { feed: { type: "string" } } });
  const feed = values.feed ? await localFeed(values.feed) : null;
  const findings = await checkOldUpdaters({ repo: join(dirname(new URL(import.meta.url).pathname), ".."), fetchImpl: feed?.fetchImpl ?? fetch });
  feed?.close();
  for (const f of findings) console.log(`${f.ok ? "ok  " : "FAIL"} ${f.release} ${f.platform}: ${f.says}`);
  process.exit(findings.every((f) => f.ok) ? 0 : 1);
}
