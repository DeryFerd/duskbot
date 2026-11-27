import { describe, expect, it } from "vitest";
import { applyEntry, areaOf, buildEntry, curatedFor, draftLine, inRange, releaseBody, settleRefs, type Gathered } from "./release-notes.ts";
import { checkAssets, parseBadging, releaseAssets } from "./release-assets.ts";

const commit = (subject: string, files: string[]) => ({ sha: "x", subject, files });

describe("release notes", () => {
  it("files a change under the area its files belong to, and leaves internal ones out", () => {
    expect(areaOf(["src/components/Chat.tsx"])).toBe("desktop");
    expect(areaOf(["apps/mobile/src/App.tsx"])).toBe("phone");
    expect(areaOf(["server/routines.ts", "shared/x.ts"])).toBe("server");
    expect(areaOf(["server/cli-update.ts"])).toBe("cli");
    expect(areaOf(["src/a.tsx", "apps/mobile/b.ts"])).toBe("all");
    expect(areaOf(["scripts/release-all.ts", "docs/releasing.md", "server/x.test.ts"])).toBeNull();
  });

  it("turns a commit subject into one plain line with its number, and drops build and test commits", () => {
    expect(draftLine(commit("routines: a script's output keeps a character split across two reads (#335)", ["server/routines.ts"])))
      .toEqual({ text: "Routines: a script's output keeps a character split across two reads.", area: "server", pr: 335 });
    expect(draftLine(commit("menu: Cmd+= makes text bigger; and more detail here (Refs #200)", ["electron/menu.mjs"])))
      .toEqual({ text: "Menu: Cmd+= makes text bigger.", area: "desktop", pr: 200 });
    expect(draftLine(commit("ios: version 1.6", ["apps/mobile/ios/x"]))?.text).toBe("iOS: version 1.6.");
    expect(draftLine(commit("user-sim: vibe suite", ["scripts/user-sim/x.ts"]))).toBeNull();
    expect(draftLine(commit("release: 0.2.31 on dusk.bot", ["apps/site/public/landing/releases/latest.json"]))).toBeNull();
    expect(draftLine(commit(`chat: ${"word ".repeat(60)}`, ["src/a.tsx"]))?.text.endsWith("…")).toBe(true);
  });

  it("calls a number an issue only when it is a closed issue and not a PR", () => {
    expect(settleRefs({ text: "a", area: "server", pr: 7 }, new Set(), new Set([7]))).toEqual({ text: "a", area: "server", issue: 7 });
    expect(settleRefs({ text: "a", area: "server", pr: 8 }, new Set([8]), new Set())).toEqual({ text: "a", area: "server", pr: 8 });
  });

  it("keeps curated lines first and does not repeat a change they already cover", () => {
    const g: Gathered = { commits: [commit("routines: utf-8 kept (#335)", ["server/r.ts"]), commit("chat: calmer shimmer", ["src/a.tsx"])], prs: [{ number: 335, title: "Preserve UTF-8", author: "p" }], issues: [] };
    const { entry, drafts } = buildEntry("0.2.32", "2026-11-27", [{ text: "Script output keeps characters.", area: "server", pr: 335 }], g);
    expect(entry).toEqual({ version: "0.2.32", date: "2026-11-27", items: [{ text: "Script output keeps characters.", area: "server", pr: 335 }] });
    expect(drafts.map(d => d.text)).toEqual(["Chat: calmer shimmer."]);
  });

  it("counts a PR merged into dev before the last release as already shipped", () => {
    const ancestors: Record<string, string[]> = { since: ["old"], to: ["old", "new"] };
    const isAncestor = (a: string, b: string) => ancestors[b]!.includes(a);
    expect(inRange("new", "since", "to", isAncestor)).toBe(true);
    expect(inRange("old", "since", "to", isAncestor)).toBe(false);
  });

  it("writes a body with what's new by area, every download including the CLI and APK, and how each install updates", () => {
    const entry = { version: "0.2.32", date: "2026-11-27", items: [{ text: "A.", area: "cli" as const }, { text: "B.", area: "phone" as const, issue: 353 }] };
    const body = releaseBody({ entry, drafts: [], g: { commits: [], prs: [], issues: [] }, since: "v0.2.31", apk: { version: "1.2.12" } });
    expect(body).toContain("### Phone app\n\n- B. ([#353](https://github.com/DuskBotAI/duskbot/issues/353))");
    expect(body.indexOf("### Phone app")).toBeLessThan(body.indexOf("### CLI"));
    expect(body).toContain("| Android phone (1.2.12) | [DuskBot.apk]");
    expect(body).toContain("[duskbot.tgz](https://github.com/DuskBotAI/duskbot-releases/releases/download/v0.2.32/duskbot.tgz)");
    expect(body).toContain("docker pull ghcr.io/duskbotai/duskbot:v0.2.32");
    expect(body).toContain("`duskbot update`");
    expect(body).not.toContain("—");
  });

  it("puts a release on top of the changelog and replaces an earlier draft of the same version", () => {
    const log = { v: 1 as const, releases: [{ version: "0.2.32", date: "x", items: [] }, { version: "0.2.31", date: "y", items: [] }] };
    expect(applyEntry(log, { version: "0.2.32", date: "z", items: [] }).releases.map(r => `${r.version}:${r.date}`)).toEqual(["0.2.32:z", "0.2.31:y"]);
  });
});

describe("release assets", () => {
  it("lists the CLI package, the APK and every desktop installer, and names what a folder lacks", () => {
    const names = releaseAssets("0.2.32").map(a => a.name);
    expect(names).toEqual(expect.arrayContaining(["duskbot-0.2.32.tgz", "duskbot.tgz", "DuskBot.apk", "DuskBot.dmg", "DuskBot-setup.exe", "DuskBot.AppImage", "SHA256SUMS", "latest.json"]));
    const check = checkAssets("0.2.32", names.filter(n => !n.startsWith("duskbot")).concat("stray.txt"));
    expect(check.missing.map(a => a.name)).toEqual(["duskbot.tgz", "duskbot-0.2.32.tgz"]);
    expect(check.extra).toEqual(["stray.txt"]);
  });

  it("reads an APK's version from aapt2's badging", () => {
    expect(parseBadging("package: name='bot.dusk.mobile' versionCode='13' versionName='1.2.12' platformBuildVersionName='16'\n")).toEqual({ version: "1.2.12", code: 13 });
    expect(parseBadging("nothing")).toBeNull();
  });
});

describe("curatedFor", () => {
  const line = { text: "Type /new for a clean chat.", area: "all" as const };
  const log = { v: 1 as const, releases: [{ version: "0.2.32", date: "2026-11-27", title: "Fresh chats", items: [line] }] };
  it("takes unreleased.json's lines while it has them", () => {
    expect(curatedFor("0.2.32", { items: [{ text: "Other.", area: "desktop" }], title: "T" }, log)).toEqual({ items: [{ text: "Other.", area: "desktop" }], title: "T" });
  });
  it("takes the applied changelog entry once --apply emptied unreleased.json, as the release job runs it", () => {
    expect(curatedFor("0.2.32", { items: [] }, log)).toEqual({ items: [line], title: "Fresh chats" });
  });
  it("has no lines for a version nobody wrote up", () => {
    expect(curatedFor("0.2.33", { items: [] }, log).items).toEqual([]);
  });
});
