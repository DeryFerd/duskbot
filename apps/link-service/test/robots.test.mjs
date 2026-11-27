// the link hosts are never pages for search: every answer says noindex, robots.txt keeps crawlers out except where they
// must look once more to drop what they listed, and the installers still download
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLinkService } from "../src/app.mjs";

let service, server, base;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "link-robots-"));
  const scriptPath = join(dir, "install.sh");
  writeFileSync(scriptPath, "echo install __LINK_BASE__\n");
  writeFileSync(join(dir, "uninstall.sh"), "echo uninstall\n");
  server = createServer((req, res) => void service.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  service = createLinkService({ base, scriptPath, agentPath: join(dir, "agent.mjs"), trustProxy: false });
});
afterAll(async () => { service.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

describe("link hosts and search engines", () => {
  it("serves a robots.txt that shuts crawlers out but lets them recheck the two listed addresses", async () => {
    const res = await fetch(`${base}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    const body = await res.text();
    expect(body).toMatch(/^User-agent: \*$/m);
    expect(body).toMatch(/^Disallow: \/$/m);
    expect(body).toMatch(/^Allow: \/install\.sh$/m);
    expect(body).toMatch(/^Allow: \/uninstall$/m);
  });

  it("says noindex on the installers, which still download", async () => {
    for (const path of ["/install.sh", "/uninstall"]) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(await res.text(), path).toMatch(/echo (install|uninstall)/);
    }
  });

  it("says noindex on the home address and on a missing one", async () => {
    for (const path of ["/", "/i/", "/nope"]) {
      const res = await fetch(base + path);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      await res.arrayBuffer();
    }
  });
});
