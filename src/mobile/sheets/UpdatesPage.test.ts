import { beforeAll, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { parseLatestFeed } from "../../../shared/release-notes";
import { phoneAppRow, serverRow } from "./UpdatesPage";

beforeAll(() => setLocale("en"));
const feed = (android?: object) => parseLatestFeed({ v: 1, version: "0.2.31", ...(android ? { android } : {}) });
const apk = "https://github.com/DuskBotAI/duskbot-releases/releases/download/v0.2.31/DuskBot.apk";

describe("this phone's row", () => {
  it("on Android, offers the newer APK when one is out", () => {
    expect(phoneAppRow("android", "1.2.9", { state: "done", feed: feed({ version: "1.2.12", code: 13, url: apk }) }))
      .toEqual({ detail: "1.2.12 is out", value: "Download", url: apk });
  });

  it("on Android, says up to date, says nothing without an android part, and can check again after a failed read", () => {
    expect(phoneAppRow("android", "1.2.12", { state: "done", feed: feed({ version: "1.2.12", url: apk }) })).toEqual({ detail: "You're up to date" });
    expect(phoneAppRow("android", "1.2.9", { state: "done", feed: feed() })).toEqual({});
    expect(phoneAppRow("android", "1.2.9", { state: "done", feed: null })).toEqual({ detail: "Couldn't check for updates. Try again.", value: "Check for updates" });
  });

  it("on an iPhone, leads to the App Store", () => {
    expect(phoneAppRow("ios", "1.2.12", { state: "checking" })).toEqual({ detail: "Updates come from the App Store", value: "App Store", url: "https://apps.apple.com/app/id6834725640" });
  });
});

describe("the server's row", () => {
  const docker = { current: "0.2.29", install: "docker" as const, available: true, latest: "0.2.31", releaseUrl: "https://github.com/DuskBotAI/duskbot/releases/tag/v0.2.31" };

  it("updates an owner's Compose server in one tap", () => {
    expect(serverRow({ state: "done", check: { ...docker, compose: { supported: true, automatic: false, phase: "idle" } } }))
      .toEqual({ label: "Server 0.2.29", detail: "0.2.31 is out.", value: "Update now", act: "apply" });
  });

  it("copies the command for anyone else, and links the release when there is none", () => {
    expect(serverRow({ state: "done", check: { ...docker, command: "docker compose pull dusk && docker compose up -d" } }))
      .toEqual({ label: "Server 0.2.29", detail: "0.2.31 is out. Update with: docker compose pull dusk && docker compose up -d", value: "Copy", act: "copy" });
    expect(serverRow({ state: "done", check: docker }).act).toBe("release");
  });

  it("says up to date, kept up to date, and can check again after a failure", () => {
    expect(serverRow({ state: "done", check: { current: "0.2.31", install: "docker", available: false, latest: "0.2.31" } }).detail).toBe("You're up to date");
    expect(serverRow({ state: "done", check: { current: "0.2.31", install: "managed", available: false } }).detail).toBe("Kept up to date for you");
    expect(serverRow({ state: "failed" }).act).toBe("check");
  });
});
