// node --test apps/mobile/ios/notification-presentation.node-test.mjs (a Mac with Xcode's swiftc)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = fileURLToPath(new URL(".", import.meta.url));
const swiftc = (() => { try { execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("willPresent shows the system banner except for the conversation on screen, and a sealed preview opens", { skip: process.platform !== "darwin" || !swiftc }, () => {
  const dir = mkdtempSync(join(tmpdir(), "dusk-presentation-"));
  try {
    const binary = join(dir, "check");
    const sources = ["App/App/NotificationPresentation.swift", "App/Shared/TurnLineKey.swift", "App/Tests/NotificationPresentation/main.swift"];
    execFileSync("xcrun", ["swiftc", ...sources.map((file) => join(here, file)), "-o", binary], { stdio: "pipe" });
    assert.equal(execFileSync(binary, { encoding: "utf8" }).trim(), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
