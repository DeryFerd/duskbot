// the `duskbot` package is not on the npm registry (scripts/build-npm-package.mjs marks it private), so any doc, page or
// message that says `npx duskbot`, `npm install -g duskbot` or `duskbot@latest` sends people to a 404. installs go
// through the release tarball (duskbot.tgz on GitHub releases) and updates through `duskbot update`. if the package is
// ever published to npm, drop `private: true` there and this check stops applying.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
export const BY_NAME = /\bnpx\s+(?:--yes\s+|-y\s+)?duskbot(?:@[\w.]+)?(?=[\s`'")\]]|$)|\bnpm\s+(?:i|install|add)\s+(?:-g|--global)\s+(?:--prefix\s+\S+\s+)?duskbot(?:@[\w.]+)?(?=[\s`'")\]]|$)|\bduskbot@(?:latest|next|\d+\.\d+\.\d+|X\.Y\.Z)\b/;

describe("install instructions", () => {
  it("never send people to npx or npm install duskbot while the package is not on npm", () => {
    const builder = readFileSync(join(ROOT, "scripts", "build-npm-package.mjs"), "utf8");
    if (!/^\s*private: true,/m.test(builder)) return;
    const files = execFileSync("git", ["ls-files", "-z", "--", "*.md", "*.html", "*.ts", "*.tsx", "*.mjs", "*.js", "*.sh", "*.yml", "*.json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20 })
      .split("\0").filter(Boolean)
      .filter(f => !/(^|\/)node_modules\/|\.test\.|\.node-test\.|^pnpm-lock|^apps\/site\/public\/landing\/releases\/|^third_party\//.test(f));
    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try { text = readFileSync(join(ROOT, file), "utf8"); } catch { continue; }
      if (!/duskbot/.test(text)) continue;
      text.split("\n").forEach((line, i) => { if (BY_NAME.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`); });
    }
    expect(hits, "install from https://github.com/DuskBotAI/duskbot-releases/releases/latest/download/duskbot.tgz and update with `duskbot update` instead").toEqual([]);
  });

  it("documents the install that works", () => {
    const tarball = "https://github.com/DuskBotAI/duskbot-releases/releases/latest/download/duskbot.tgz";
    expect(readFileSync(join(ROOT, "docs/self-hosting.md"), "utf8")).toContain(tarball);
    expect(readFileSync(join(ROOT, "docs/cli-onboarding.md"), "utf8")).toContain(tarball);
  });

  it("knows the forms that 404 and the ones that work", () => {
    for (const bad of ["npx duskbot", "npx duskbot start", "run `npx -y duskbot serve`", "npm install -g duskbot", "npm i --global duskbot@0.2.31", "npx duskbot@latest", "npm install --global --prefix /home/x/.local duskbot@X.Y.Z"]) expect(BY_NAME.test(bad), bad).toBe(true);
    for (const good of ["npm install --global --prefix \"$HOME/.local\" https://github.com/DuskBotAI/duskbot-releases/releases/latest/download/duskbot.tgz", "duskbot serve", "npm install -g ./duskbot-0.2.31.tgz", "npx duskbot-helper", "@duskbot/mobile"]) expect(BY_NAME.test(good), good).toBe(false);
  });
});
