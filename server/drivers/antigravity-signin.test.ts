import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { antigravityProfileAuthenticated, prepareAntigravityProfile, removeAntigravitySignIn } from "./antigravity-acp.ts";
import {
  acceptNewAntigravitySignIn,
  antigravityKeepPath,
  ensureAntigravitySignIn,
  forgetAntigravitySignIn,
  withAntigravitySignInGate,
} from "./antigravity-signin.ts";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "dusk-agy-signin-")); scratch.push(dir); return dir; };
const token = (refresh: string | null, access = "a") => JSON.stringify({ token: { access_token: access, ...(refresh ? { refresh_token: refresh } : {}), expiry: "2099-01-01T00:00:00Z" }, id_token_email: "x@example.test" });
const paths = (dir: string) => { mkdirSync(dir, { recursive: true }); return { tokenPath: join(dir, "antigravity-oauth-token"), legacyTokenPath: join(dir, "acp_token.json") }; };

describe("the Google sign-in survives what happens to its file", () => {
  it("puts the sign-in back when the CLI's file vanished", async () => {
    const p = paths(temp());
    writeFileSync(p.tokenPath, token("r1"));
    expect(await ensureAntigravitySignIn(p)).toBe("kept");
    rmSync(p.tokenPath);
    expect(await antigravityProfileAuthenticated(p)).toBe(true);
    expect(readFileSync(p.tokenPath, "utf8")).toBe(token("r1"));
  });

  it("puts it back when a rewrite was cut short", async () => {
    const p = paths(temp());
    writeFileSync(p.tokenPath, token("r1"));
    await ensureAntigravitySignIn(p);
    writeFileSync(p.tokenPath, '{"token":{"access_tok');
    expect(await ensureAntigravitySignIn(p)).toBe("restored");
    expect(readFileSync(p.tokenPath, "utf8")).toBe(token("r1"));
  });

  it("puts it back when the file lost its refresh token", async () => {
    const p = paths(temp());
    writeFileSync(p.tokenPath, token("r1"));
    await ensureAntigravitySignIn(p);
    writeFileSync(p.tokenPath, token(null, "fresh"));
    expect(await ensureAntigravitySignIn(p)).toBe("restored");
    expect(readFileSync(p.tokenPath, "utf8")).toBe(token("r1"));
  });

  it("never overwrites a renewal with the older copy", async () => {
    const p = paths(temp());
    writeFileSync(p.tokenPath, token("r1"));
    await ensureAntigravitySignIn(p);
    writeFileSync(p.tokenPath, token("r2", "renewed"));
    expect(await ensureAntigravitySignIn(p)).toBe("kept");
    rmSync(p.tokenPath);
    await ensureAntigravitySignIn(p);
    expect(readFileSync(p.tokenPath, "utf8")).toBe(token("r2", "renewed"));
  });

  it("a new account replaces the copy, and a sign-out is never undone", async () => {
    const p = paths(temp());
    writeFileSync(p.tokenPath, token("r1"));
    await ensureAntigravitySignIn(p);
    writeFileSync(p.tokenPath, token(null, "other-account"));
    await acceptNewAntigravitySignIn(p);
    expect(readFileSync(p.tokenPath, "utf8")).toBe(token(null, "other-account"));
    writeFileSync(p.tokenPath, token("r3"));
    await ensureAntigravitySignIn(p);
    await forgetAntigravitySignIn(p);
    expect(existsSync(antigravityKeepPath(p.tokenPath))).toBe(false);
    expect(await antigravityProfileAuthenticated(p)).toBe(false);
  });

  it("is signed out when nothing was ever kept", async () => {
    const p = paths(temp());
    expect(await antigravityProfileAuthenticated(p)).toBe(false);
    writeFileSync(p.tokenPath, "not json");
    expect(await antigravityProfileAuthenticated(p)).toBe(false);
  });

  it("runs work on one profile one after another, and a failure does not block the next", async () => {
    const order: string[] = [];
    const slow = withAntigravitySignInGate("k", async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 30)); order.push("a-end"); });
    const fast = withAntigravitySignInGate("k", async () => { order.push("b"); });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
    await withAntigravitySignInGate("j", async () => { throw new Error("x"); }).catch(() => {});
    expect(await withAntigravitySignInGate("j", async () => 7)).toBe(7);
  });

  it("removeAntigravitySignIn takes the copy too", async () => {
    const base = temp();
    const profile = await prepareAntigravityProfile({ instanceId: "acct", runtime: { executablePath: "agy", version: "1.5.0" } as never, baseDir: base, baseEnv: { PATH: process.env.PATH } });
    writeFileSync(profile.tokenPath, token("r1"));
    await ensureAntigravitySignIn(profile);
    await removeAntigravitySignIn("acct", base);
    expect(existsSync(profile.tokenPath)).toBe(false);
    expect(existsSync(antigravityKeepPath(profile.tokenPath))).toBe(false);
  });
});

describe("every install type keeps its sign-in in the profile it renews", () => {
  const runtime = { executablePath: "agy", version: "1.5.0" } as never;
  const types: Array<{ name: string; platform: NodeJS.Platform; baseEnv: NodeJS.ProcessEnv }> = [
    { name: "desktop on macOS or Linux", platform: "darwin", baseEnv: { PATH: process.env.PATH, HOME: "/Users/someone" } },
    { name: "desktop on Windows", platform: "win32", baseEnv: { PATH: process.env.PATH, USERPROFILE: "C:\\Users\\someone" } },
    { name: "dusk cloud (HOME=/data)", platform: "linux", baseEnv: { PATH: process.env.PATH, HOME: "/data" } },
    { name: "own server under a service user over ssh", platform: "linux", baseEnv: { PATH: process.env.PATH, HOME: "/home/dusk", SSH_CONNECTION: "10.0.0.2 5 10.0.0.1 22" } },
    { name: "own server under systemd with no HOME", platform: "linux", baseEnv: { PATH: process.env.PATH } },
  ];
  it.each(types)("$name: file storage inside the data folder, never the keyring or HOME", async ({ platform, baseEnv }) => {
    const base = temp();
    const profile = await prepareAntigravityProfile({ instanceId: "acct", runtime, baseDir: base, baseEnv, platform, tempDirectory: join(base, "tmp") });
    expect(profile.environment.GEMINI_HOME).toBe(profile.directory);
    expect(profile.directory.startsWith(join(base, "providers", "antigravity"))).toBe(true);
    expect(profile.environment.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe("1");
    expect(profile.environment.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
    expect(profile.environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    expect(profile.tokenPath.startsWith(profile.directory)).toBe(true);
    expect(profile.tempDirectory !== undefined).toBe(platform === "win32");
    writeFileSync(profile.tokenPath, token("r1"));
    await ensureAntigravitySignIn(profile);
    rmSync(profile.tokenPath);
    expect(await antigravityProfileAuthenticated(profile)).toBe(true);
  });

  it("a second prepare of the same account keeps the same profile and its sign-in (restart, update, package reinstall)", async () => {
    const base = temp();
    const first = await prepareAntigravityProfile({ instanceId: "acct", runtime, baseDir: base, baseEnv: { PATH: process.env.PATH } });
    writeFileSync(first.tokenPath, token("r1"));
    const second = await prepareAntigravityProfile({ instanceId: "acct", runtime: { executablePath: "/new/agy", version: "1.6.0" } as never, baseDir: base, baseEnv: { PATH: process.env.PATH } });
    expect(second.tokenPath).toBe(first.tokenPath);
    expect(readFileSync(second.tokenPath, "utf8")).toBe(token("r1"));
  });
});
