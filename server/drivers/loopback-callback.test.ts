import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserRecorder } from "./loopback-callback.ts";

const link = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback&state=a!b";

describe("the $BROWSER a sign-in CLI is given, which records its link and opens nothing", () => {
  it("on Windows too: a batch file, so Claude Code's own localhost tab is not opened next to the app's", () => {
    const recorder = browserRecorder("win32");
    try {
      expect(recorder.env.BROWSER).toMatch(/dusk-signin-[^\\/]+[\\/]open\.cmd$/);
      const script = readFileSync(recorder.env.BROWSER, "utf8");
      expect(script.split("\r\n")).toEqual([
        "@echo off",
        "setlocal DisableDelayedExpansion",
        'set "link=%~1"',
        "setlocal EnableDelayedExpansion",
        '>"%~dp0link.tmp" echo(!link!',
        'move /y "%~dp0link.tmp" "%~dp0link" >nul',
        "",
      ]);
      expect(recorder.read()).toBeNull();
      // what the batch file leaves behind: echo ends the line with CRLF
      writeFileSync(join(dirname(recorder.env.BROWSER), "link"), `${link}\r\n`);
      expect(recorder.read()).toBe(link);
    } finally { recorder.dispose(); }
    expect(existsSync(recorder.env.BROWSER)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("on macOS and Linux a shell script that records the link whole", () => {
    const recorder = browserRecorder("darwin");
    try {
      execFileSync(recorder.env.BROWSER, [link]);
      expect(recorder.read()).toBe(link);
    } finally { recorder.dispose(); }
  });
});
