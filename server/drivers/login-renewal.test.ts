import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeCredentialsFile, claudeRefusalIsSignOut, claudeRenewalSource, enterClaudeRenewal } from "./claude-stored-login.ts";
import { codexRenewalSource, codexRenewalState, enterCodexRenewal } from "./codex-login.ts";
import { enterRenewal, type RenewalSource } from "./login-renewal.ts";

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dusk-renewal-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const HOUR = 3_600_000;
const jwt = (expSeconds: number) => `x.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.y`;
const idle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The provider's token endpoint: a refresh token works once, and renewing with a retired one is refused. */
function rotatingAuthority(first: string) {
  let live = first, n = 0;
  const refusals: string[] = [];
  return {
    refusals,
    renew(token: string): string | null {
      if (token !== live) { refusals.push(token); return null; }
      live = `rt-${++n}`;
      return live;
    },
  };
}

/** A login in a file and the CLI processes that renew it: each reads the file when it starts, takes a moment at the
 * provider, then saves the new pair (what Claude Code and Codex do). */
function install(dir: string) {
  const file = join(dir, "login.json");
  const read = () => JSON.parse(readFileSync(file, "utf8")) as { refresh: string; expires: number };
  const write = (value: { refresh: string; expires: number }) => writeFileSync(file, JSON.stringify(value));
  const authority = rotatingAuthority("rt-0");
  write({ refresh: "rt-0", expires: Date.now() + 60_000 });
  const source: RenewalSource = { key: file, due: (now) => read().expires - now <= 600_000, version: () => read().refresh };
  const process = async (hold: Awaited<ReturnType<typeof enterRenewal>>) => {
    const child = { exitCode: null as number | null, signalCode: null };
    hold.track(child);
    const seen = read();
    if (seen.expires - Date.now() > 600_000) { child.exitCode = 0; return "fresh"; }
    await idle(60);
    const next = authority.renew(seen.refresh);
    if (!next) { child.exitCode = 1; return "invalid_grant"; }
    write({ refresh: next, expires: Date.now() + 8 * HOUR });
    child.exitCode = 0;
    return "renewed";
  };
  return { source, authority, process, lockDir: join(dir, "locks") };
}

describe("one renewal at a time per login", () => {
  it("without the lock, bots starting together renew one login at once and the losers are refused", async () => {
    const { authority, process } = install(scratch());
    const answers = await Promise.all([1, 2, 3].map(() => process(enterRenewalNone())));
    expect(answers).toContain("invalid_grant");
    expect(authority.refusals.length).toBeGreaterThan(0);
  });

  it("with it, every one of them finds a login that works and the provider refuses none", async () => {
    const { authority, process, source, lockDir } = install(scratch());
    const answers = await Promise.all([1, 2, 3, 4].map(async () => process(await enterRenewal(source, { lockDir }))));
    expect(answers.filter((answer) => answer === "renewed")).toHaveLength(1);
    expect(answers.filter((answer) => answer === "fresh")).toHaveLength(3);
    expect(authority.refusals).toEqual([]);
  });

  it("takes nothing for a login that is not due", async () => {
    const dir = scratch();
    const { source, lockDir } = install(dir);
    const fresh: RenewalSource = { ...source, due: () => false };
    const hold = await enterRenewal(fresh, { lockDir });
    expect(hold.release).toBeTypeOf("function");
    await expect(enterRenewal(fresh, { lockDir })).resolves.toBeDefined();
  });

  it("clears a lock whose owner died, and never holds a turn back for good", async () => {
    const dir = scratch();
    const { source, lockDir } = install(dir);
    const first = await enterRenewal(source, { lockDir });
    // a second one that waits only a moment gives up and goes on instead of hanging the turn
    const started = Date.now();
    const second = await enterRenewal(source, { lockDir, waitMs: 400 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    second.release();
    first.release();
    expect(readdirSync(lockDir)).toEqual([]);
    // a lock left by a process that is gone (pid 2^22 is never alive here)
    const { createHash } = await import("node:crypto");
    const name = `${createHash("sha256").update(source.key).digest("hex").slice(0, 24)}.lock`;
    writeFileSync(join(lockDir, name), `${4_194_303} ${Date.now()}`);
    const third = await enterRenewal(source, { lockDir, waitMs: 5_000 });
    third.release();
  });

  it("is released when the process holding it exits before the renewal lands", async () => {
    const { source, lockDir } = install(scratch());
    const first = await enterRenewal(source, { lockDir });
    const child = { exitCode: null as number | null, signalCode: null };
    first.track(child);
    child.exitCode = 1;
    const second = await enterRenewal(source, { lockDir, waitMs: 5_000 });
    second.release();
  });
});

function enterRenewalNone() {
  return { track() {}, release() {} };
}

describe("each install type", () => {
  it("Claude Code on Mac keeps its login in the Keychain: no file, nothing to lock, turns start at once", async () => {
    const home = scratch();
    mkdirSync(join(home, ".claude"));
    expect(claudeRenewalSource({ HOME: home })?.due(Date.now())).toBe(false);
    await expect(enterClaudeRenewal({ HOME: home })).resolves.toBeDefined();
  });

  it("a VPS service on a Claude token from its environment has no file to renew", () => {
    expect(claudeCredentialsFile({ HOME: "/home/dusk", CLAUDE_CODE_OAUTH_TOKEN: "x".repeat(30) })).toBeNull();
    expect(claudeRenewalSource({ HOME: "/home/dusk", CLAUDE_CODE_OAUTH_TOKEN: "x".repeat(30) })).toBeNull();
  });

  it("Windows, Linux, a cloud and a VPS service user keep it in HOME or CLAUDE_CONFIG_DIR, and agree on one lock per file", () => {
    const home = scratch();
    const a = claudeRenewalSource({ HOME: home });
    const b = claudeRenewalSource({ USERPROFILE: home });
    const c = claudeRenewalSource({ HOME: "/elsewhere", CLAUDE_CONFIG_DIR: join(home, ".claude") });
    expect(a?.key).toBe(join(home, ".claude", ".credentials.json"));
    expect(b?.key).toBe(a?.key);
    expect(c?.key).toBe(a?.key);
  });

  it("a due Claude login in HOME is renewed by one process at a time", async () => {
    const home = scratch();
    mkdirSync(join(home, ".claude"));
    const file = join(home, ".claude", ".credentials.json");
    const save = (token: string, expiresAt: number) => writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r", expiresAt } }));
    save("a1", Date.now() + 60_000);
    const lockDir = join(home, "locks");
    const first = await enterClaudeRenewal({ HOME: home }, { lockDir });
    const waiting = enterClaudeRenewal({ HOME: home }, { lockDir, waitMs: 5_000 });
    let entered = false;
    void waiting.then(() => { entered = true; });
    await idle(300);
    expect(entered).toBe(false);
    save("a2", Date.now() + 8 * HOUR);
    first.track({ exitCode: null, signalCode: null });
    (await waiting).release();
    expect(entered).toBe(true);
  });

  it("Codex's ChatGPT login is due by its access token's end, or a week without renewal, and an API key never is", () => {
    const now = Date.now();
    const chatgpt = (exp: number, last: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(exp), refresh_token: "r1" }, last_refresh: last });
    expect(codexRenewalState(chatgpt(now / 1000 + 5 * 60, new Date(now).toISOString()), now).due).toBe(true);
    expect(codexRenewalState(chatgpt(now / 1000 + 5 * 24 * 3600, new Date(now - 8 * 24 * HOUR).toISOString()), now).due).toBe(true);
    expect(codexRenewalState(chatgpt(now / 1000 + 5 * 24 * 3600, new Date(now - 1 * HOUR).toISOString()), now).due).toBe(false);
    expect(codexRenewalState(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk" }), now)).toEqual({ due: false, version: null });
    expect(codexRenewalState(null, now).due).toBe(false);
  });

  it("two bots of one cloud or VPS start Codex together on one CODEX_HOME: one renews, the other reads its result", async () => {
    const home = scratch();
    mkdirSync(join(home, ".codex"));
    const file = join(home, ".codex", "auth.json");
    const authority = rotatingAuthority("r0");
    const save = (refresh: string, expSeconds: number) => writeFileSync(file, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(expSeconds), refresh_token: refresh }, last_refresh: new Date().toISOString() }));
    save("r0", Date.now() / 1000 + 60);
    const env = { HOME: home, CODEX_HOME: join(home, ".codex") };
    expect(codexRenewalSource(env)?.key).toBe(file);
    const lockDir = join(home, "locks");
    const boot = async () => {
      const hold = await enterCodexRenewal(env, { lockDir });
      const child = { exitCode: null as number | null, signalCode: null };
      hold.track(child);
      const seen = JSON.parse(readFileSync(file, "utf8")).tokens.refresh_token as string;
      const due = codexRenewalState(readFileSync(file, "utf8"), Date.now()).due;
      if (due) {
        await idle(50);
        const next = authority.renew(seen);
        if (next) save(next, Date.now() / 1000 + 8 * 3600);
      }
      child.exitCode = 0;
    };
    await Promise.all([boot(), boot(), boot()]);
    expect(authority.refusals).toEqual([]);
  });
});

describe("a refused turn on a login that is still saved", () => {
  const home = () => {
    const dir = scratch();
    mkdirSync(join(dir, ".claude"));
    return dir;
  };
  const save = (dir: string, oauth: Record<string, unknown>) => writeFileSync(join(dir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));

  it("is one failed turn the first time and a sign-out when the same token is refused again", () => {
    const dir = home();
    save(dir, { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + HOUR });
    const env = { HOME: dir };
    expect(claudeRefusalIsSignOut(env, 1_000)).toBe(false);
    expect(claudeRefusalIsSignOut(env, 2_000)).toBe(false);
    expect(claudeRefusalIsSignOut(env, 60_000)).toBe(true);
  });

  it("is a sign-out at once when the file is blank, gone, or the login is not here to read", () => {
    const dir = home();
    save(dir, { accessToken: "", refreshToken: "", expiresAt: 0 });
    expect(claudeRefusalIsSignOut({ HOME: dir })).toBe(true);
    expect(claudeRefusalIsSignOut({ HOME: scratch() })).toBe(true);
    expect(claudeRefusalIsSignOut({ HOME: dir, CLAUDE_CODE_OAUTH_TOKEN: "t".repeat(30) })).toBe(true);
  });
});
