import { describe, expect, it } from "vitest";
import { LATEST_APK_URL, apkBehind, parseChangelog, parseLatestFeed, releasesBetween, releasesFor } from "./release-notes";

const body = {
  v: 1,
  releases: [
    { version: "0.2.30", date: "2026-11-21", items: [{ text: "Docker servers update themselves", area: "server" }] },
    { version: "0.2.32", date: "2026-11-27", title: "Updates everywhere", items: [{ text: "Check for updates on the phone", area: "phone", issue: 353 }, { text: "  Enter queues\n a message ", area: "desktop" }] },
    { version: "0.2.31", items: [{ text: "Zip attachments", area: "all" }, { text: "", area: "all" }, { text: "Odd area", area: "watch" }] },
    { version: "latest", items: [{ text: "not a version", area: "all" }] },
    { version: "0.2.29", items: [] },
  ],
};

describe("changelog.json", () => {
  it("reads nothing from a missing or odd file", () => {
    for (const odd of [null, undefined, "", 404, {}, { releases: "no" }, { releases: [null, 3, "x"] }]) expect(parseChangelog(odd)).toEqual([]);
  });

  it("keeps real releases newest first, with tidy lines, and drops what is not one", () => {
    const releases = parseChangelog(body);
    expect(releases.map((release) => release.version)).toEqual(["0.2.32", "0.2.31", "0.2.30"]);
    expect(releases[0]).toEqual({ version: "0.2.32", date: "2026-11-27", title: "Updates everywhere", items: [
      { text: "Check for updates on the phone", area: "phone", issue: 353 }, { text: "Enter queues a message", area: "desktop" },
    ] });
    expect(releases[1]!.items).toEqual([{ text: "Zip attachments", area: "all" }, { text: "Odd area", area: "all" }]);
  });

  it("gives each surface its own lines and the lines for everyone", () => {
    const phone = releasesFor(parseChangelog(body), ["phone", "server"]);
    expect(phone.map((release) => [release.version, release.items.map((item) => item.text)])).toEqual([
      ["0.2.32", ["Check for updates on the phone"]], ["0.2.31", ["Zip attachments", "Odd area"]], ["0.2.30", ["Docker servers update themselves"]],
    ]);
    expect(releasesFor(parseChangelog(body), ["cli"]).map((release) => release.version)).toEqual(["0.2.31"]);
  });

  it("finds what an update brought: after the old version, up to the new one", () => {
    const releases = parseChangelog(body);
    expect(releasesBetween(releases, "0.2.30", "0.2.32").map((release) => release.version)).toEqual(["0.2.32", "0.2.31"]);
    expect(releasesBetween(releases, "0.2.31", "0.2.31")).toEqual([]);
    expect(releasesBetween(releases, null, "0.2.31").map((release) => release.version)).toEqual(["0.2.31", "0.2.30"]);
  });
});

describe("latest.json for Android", () => {
  const feed = (android: unknown) => parseLatestFeed({ v: 1, version: "0.2.31", signature: "r1.x", android });

  it("says nothing without an android part", () => {
    expect(parseLatestFeed({ v: 1, version: "0.2.31" })).toEqual({ version: "0.2.31", android: null });
    expect(parseLatestFeed(null)).toEqual({ version: null, android: null });
    expect(feed({ version: "soon" }).android).toBeNull();
    expect(apkBehind(parseLatestFeed(null), { version: "1.2.9" })).toBe(false);
  });

  it("links only dusk bot's own downloads", () => {
    expect(feed({ version: "1.2.12", code: 13, url: "https://github.com/DuskBotAI/duskbot-releases/releases/download/v0.2.31/DuskBot.apk" }).android)
      .toEqual({ version: "1.2.12", code: 13, url: "https://github.com/DuskBotAI/duskbot-releases/releases/download/v0.2.31/DuskBot.apk" });
    expect(feed({ version: "1.2.12", url: "https://evil.example/DuskBot.apk" }).android).toEqual({ version: "1.2.12", code: null, url: LATEST_APK_URL });
  });

  it("compares the build number when both say one, else the version", () => {
    const newer = feed({ version: "1.2.12", code: 13 });
    expect(apkBehind(newer, { version: "1.2.9" })).toBe(true);
    expect(apkBehind(newer, { version: "1.2.12" })).toBe(false);
    expect(apkBehind(newer, { version: "1.2.13" })).toBe(false);
    expect(apkBehind(newer, { version: "1.2.12", build: 12 })).toBe(true);
    expect(apkBehind(newer, { version: "9.9.9", build: 13 })).toBe(false);
    expect(apkBehind(newer, { version: "dev" })).toBe(false);
  });
});
