import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { killCliTree, type execCli } from "../procs.ts";
import { claudeAuthStatus } from "./claude-auth-status.ts";
import { CLAUDE_RENEWAL_MARGIN_MS, claudeCredentialsFile, claudeRenewalDue, killClaudeTree, readClaudeStoredLogin, settleClaudeRenewal } from "./claude-stored-login.ts";

const HOUR = 60 * 60_000;
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dusk-claude-login-"));
  homes.push(dir);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

const credentials = (dir: string) => join(dir, ".claude", ".credentials.json");
const save = (dir: string, oauth: Record<string, unknown>) => writeFileSync(credentials(dir), JSON.stringify({ claudeAiOauth: { scopes: ["user:inference"], ...oauth } }));
const stored = (dir: string) => (JSON.parse(readFileSync(credentials(dir), "utf8")) as { claudeAiOauth: { accessToken: string; refreshToken: string; expiresAt: number } }).claudeAiOauth;

/** claude.ai's token endpoint as Claude Code meets it: every renewal retires the refresh token it was given. */
function rotatingAuthority(first: string) {
  let live = first, n = 0;
  return {
    renew(refreshToken: string): { accessToken: string; refreshToken: string } | "invalid_grant" {
      if (refreshToken !== live) return "invalid_grant";
      n += 1;
      live = `rt-${n}`;
      return { accessToken: `at-${n}`, refreshToken: live };
    },
  };
}

/** Claude Code 2.1.288 on Linux: a process renews a login due for renewal when it starts and saves the new pair; a
 * renewal that finds its refresh token retired blanks the login. `auth status` renews and exits before saving. */
function cli(dir: string, authority: ReturnType<typeof rotatingAuthority>, now: () => number) {
  const renew = (persist: boolean): "ok" | "dead" => {
    const oauth = stored(dir);
    if (oauth.expiresAt - now() > 5 * 60_000) return "ok";
    const answer = authority.renew(oauth.refreshToken);
    if (answer === "invalid_grant") {
      save(dir, { accessToken: "", refreshToken: "", expiresAt: 0 });
      return "dead";
    }
    if (persist) save(dir, { ...answer, expiresAt: now() + 8 * HOUR });
    return "ok";
  };
  const authStatus: typeof execCli = ((_cli: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
    const signedIn = stored(dir).refreshToken !== "" && renew(false) === "ok";
    done(null, JSON.stringify({ loggedIn: signedIn, authMethod: "claude.ai", email: "person@example.test" }));
  }) as unknown as typeof execCli;
  return { authStatus, turn: () => renew(true) };
}

describe("a Claude login due for renewal", () => {
  it("is not asked about with auth status, so the next turn still renews it (the sign-in lost after every idle night)", async () => {
    const dir = home();
    let clock = Date.parse("2026-11-25T03:30:56Z");
    save(dir, { accessToken: "at-0", refreshToken: "rt-0", expiresAt: clock - HOUR });
    const claude = cli(dir, rotatingAuthority("rt-0"), () => clock);

    const status = await claudeAuthStatus("claude", { HOME: dir }, claude.authStatus, clock);
    clock += 5_000;

    expect(claude.turn()).toBe("ok");
    expect(stored(dir).refreshToken).toBe("rt-1");
    expect(status).toEqual({ authenticated: true, renewalDue: true });
  });

  it("loses the sign-in when a short-lived auth status renews it first", async () => {
    const dir = home();
    const clock = Date.parse("2026-11-25T03:30:56Z");
    save(dir, { accessToken: "at-0", refreshToken: "rt-0", expiresAt: clock - HOUR });
    const claude = cli(dir, rotatingAuthority("rt-0"), () => clock);

    await new Promise((resolve) => claude.authStatus("claude", [], {}, resolve as never));

    expect(claude.turn()).toBe("dead");
    expect(stored(dir)).toMatchObject({ accessToken: "", refreshToken: "" });
  });

  it("is asked about once renewed, and a blanked login reads signed out", async () => {
    const dir = home();
    const clock = Date.now();
    const claude = cli(dir, rotatingAuthority("rt-0"), () => clock);
    save(dir, { accessToken: "at-0", refreshToken: "rt-0", expiresAt: clock + 2 * HOUR });
    expect(await claudeAuthStatus("claude", { HOME: dir }, claude.authStatus, clock)).toEqual({ authenticated: true, account: { email: "person@example.test" } });

    save(dir, { accessToken: "", refreshToken: "", expiresAt: 0 });
    expect(readClaudeStoredLogin(credentials(dir))).toEqual({ state: "blank" });
    expect(await claudeAuthStatus("claude", { HOME: dir }, claude.authStatus, clock)).toEqual({ authenticated: false });
  });

  it("reads due only for a renewable file login near its expiry", () => {
    const dir = home();
    const now = Date.now();
    save(dir, { accessToken: "at", refreshToken: "rt", expiresAt: now + CLAUDE_RENEWAL_MARGIN_MS - 1 });
    expect(claudeRenewalDue(readClaudeStoredLogin(credentials(dir)), now)).toBe(true);
    save(dir, { accessToken: "at", refreshToken: "rt", expiresAt: now + CLAUDE_RENEWAL_MARGIN_MS + 60_000 });
    expect(claudeRenewalDue(readClaudeStoredLogin(credentials(dir)), now)).toBe(false);
    save(dir, { accessToken: "at", refreshToken: "", expiresAt: now - 1 });
    expect(claudeRenewalDue(readClaudeStoredLogin(credentials(dir)), now)).toBe(false);
    expect(readClaudeStoredLogin(join(dir, "missing.json"))).toEqual({ state: "none" });
    expect(claudeCredentialsFile({ HOME: dir })).toBe(credentials(dir));
    expect(claudeCredentialsFile({ HOME: dir, CLAUDE_CONFIG_DIR: "/srv/claude" })).toBe(join("/srv/claude", ".credentials.json"));
    for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) expect(claudeCredentialsFile({ HOME: dir, [name]: "x" })).toBeNull();
  });
});

describe("stopping a Claude process", () => {
  it("returns at once when no renewal is due", async () => {
    const dir = home();
    save(dir, { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 2 * HOUR });
    let slept = 0;
    await settleClaudeRenewal(credentials(dir), { sleep: async () => { slept += 1; } });
    expect(slept).toBe(0);
  });

  it("waits for a due renewal to be saved, or for the limit, or for the process to end", async () => {
    const dir = home();
    let clock = 0;
    save(dir, { accessToken: "at-0", refreshToken: "rt-0", expiresAt: clock - 1 });
    let polls = 0;
    await settleClaudeRenewal(credentials(dir), { now: () => clock, sleep: async (ms) => { clock += ms; polls += 1; if (polls === 3) save(dir, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: clock + 8 * HOUR }); } });
    expect(polls).toBe(3);

    save(dir, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: clock - 1 });
    const start = clock;
    await settleClaudeRenewal(credentials(dir), { now: () => clock, sleep: async (ms) => { clock += ms; }, limitMs: 1_000 });
    expect(clock - start).toBeGreaterThanOrEqual(1_000);

    polls = 0;
    await settleClaudeRenewal(credentials(dir), { now: () => clock, sleep: async (ms) => { clock += ms; polls += 1; }, gone: () => polls >= 2 });
    expect(polls).toBe(2);
  });

  it("lets a process that is renewing save the new tokens before it is killed", { timeout: 20_000 }, async () => {
    const renewing = (dir: string) => spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      setTimeout(() => fs.writeFileSync(${JSON.stringify(credentials(dir))}, JSON.stringify({ claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 8 * 3600000 } })), 700);
      setInterval(() => {}, 1000);
    `], { stdio: "ignore", detached: process.platform !== "win32" });
    const expired = { accessToken: "at-0", refreshToken: "rt-0", expiresAt: Date.now() - HOUR };

    const lost = home();
    save(lost, expired);
    const first = renewing(lost);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await killCliTree(first, 0);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(stored(lost).refreshToken).toBe("rt-0");

    const kept = home();
    save(kept, expired);
    const second = renewing(kept);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await killClaudeTree(second, { HOME: kept }, 0)).toBe(true);
    expect(stored(kept).refreshToken).toBe("rt-1");
  });
});
