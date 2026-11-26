import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// macOS 26 is Darwin 25: the first with the on-device SpeechAnalyzer the helper listens through without any key
const analyzer =
  process.platform === "darwin" &&
  Number(release().split(".")[0]) >= 25 &&
  spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" }).status === 0;

test("the Mac's own on-device speech turns a recording into the right words, with no key and no prompt", { skip: !analyzer && "needs macOS 26 with swiftc" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "speech-helper-file-"));
  try {
    const bin = join(dir, "speech-helper");
    execFileSync("xcrun", ["swiftc", "-Onone", fileURLToPath(new URL("./resources/speech-helper.swift", import.meta.url)), "-o", bin], { timeout: 180_000 });
    const aiff = join(dir, "clip.aiff");
    const wav = join(dir, "clip.wav");
    execFileSync("say", ["-o", aiff, "Please book a table for four people at seven tonight"], { timeout: 30_000 });
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav], { timeout: 30_000 });
    // --file never touches the microphone, so it runs without asking for anything
    const run = spawnSync(bin, ["--file", wav, "--locale", "en-US"], { encoding: "utf8", timeout: 120_000 });
    // a Mac whose on-device speech model is not installed (a fresh CI runner) says so; the helper's own answer for it
    if (run.stdout.trim() === '{"error":"recognizer-unavailable"}') return t.skip("this Mac has no on-device speech model installed");
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const lines = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const final = lines.at(-1);
    assert.equal(final.partial, false);
    assert.match(final.text.toLowerCase(), /book a table for (4|four) people at (7|seven) tonight/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
