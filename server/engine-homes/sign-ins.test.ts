import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SETTLED_MS, syncSignIn } from "./sign-ins.ts";

let root = "", team = "", bob = "", owner = "";
const credentials = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token } });
const write = (path: string, text: string, ageMs = 60_000) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
};
const files = () => ({ bob: { source: team, target: bob }, owner: { source: team, target: owner } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dusk-sign-ins-"));
  team = join(root, "server", ".claude", ".credentials.json");
  bob = join(root, "bob", ".claude", ".credentials.json");
  owner = join(root, "owner", ".claude", ".credentials.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the team's sign-in in an audience's home", () => {
  it("is copied in, private to the server's user, and left alone while nothing changed", () => {
    write(team, credentials("tok-1"));
    expect(syncSignIn(files().bob)).toBe("copied");
    expect(readFileSync(bob, "utf8")).toBe(credentials("tok-1"));
    if (process.platform !== "win32") expect(statSync(bob).mode & 0o077).toBe(0);
    expect(syncSignIn(files().bob)).toBe("same");
    // The team signs in again: every audience gets the new one.
    write(team, credentials("tok-2"), 1_000);
    expect(syncSignIn(files().bob)).toBe("copied");
    expect(readFileSync(bob, "utf8")).toBe(credentials("tok-2"));
  });

  it("a refresh an engine wrote in one audience becomes the team's, in place, and reaches the others", () => {
    write(team, credentials("tok-1"));
    syncSignIn(files().bob);
    syncSignIn(files().owner);
    const inode = statSync(team).ino;
    write(bob, credentials("tok-1+"), SETTLED_MS + 500);
    expect(syncSignIn(files().owner, [bob])).toBe("taken back");
    expect(readFileSync(team, "utf8")).toBe(credentials("tok-1+"));
    expect(statSync(team).ino).toBe(inode);
    expect(readFileSync(owner, "utf8")).toBe(credentials("tok-1+"));
    expect(syncSignIn(files().bob, [owner])).toBe("same");
  });

  it("a shorter refresh replaces the whole team's file, in place", () => {
    write(team, credentials("tok-1-long-access-token"));
    syncSignIn(files().bob);
    const inode = statSync(team).ino;
    write(bob, credentials("tok-2"), SETTLED_MS + 500);
    expect(syncSignIn(files().owner, [bob])).toBe("taken back");
    expect(readFileSync(team, "utf8")).toBe(credentials("tok-2"));
    expect(statSync(team).ino).toBe(inode);
    expect(readFileSync(owner, "utf8")).toBe(credentials("tok-2"));
  });

  it("a copy still being written, or one that does not read whole, is never taken back", () => {
    write(team, credentials("tok-1"));
    syncSignIn(files().bob);
    write(bob, credentials("tok-1+"), 0);
    expect(syncSignIn(files().bob)).toBe("same");
    expect(readFileSync(bob, "utf8")).toBe(credentials("tok-1+"));
    expect(readFileSync(team, "utf8")).toBe(credentials("tok-1"));
    write(bob, '{"claudeAiOauth": {"accessTo', SETTLED_MS + 500);
    expect(syncSignIn(files().bob)).toBe("copied");
    expect(readFileSync(team, "utf8")).toBe(credentials("tok-1"));
    expect(readFileSync(bob, "utf8")).toBe(credentials("tok-1"));
  });

  it("goes when the team signs out, and a link or folder where the copy belongs is replaced by a copy", () => {
    write(team, credentials("tok-1"));
    syncSignIn(files().bob);
    rmSync(team);
    expect(syncSignIn(files().bob)).toBe("removed");
    expect(existsSync(bob)).toBe(false);
    write(team, credentials("tok-3"));
    if (process.platform !== "win32") {
      symlinkSync(join(root, "elsewhere"), bob);
      expect(syncSignIn(files().bob)).toBe("copied");
      expect(lstatSync(bob).isFile()).toBe(true);
    }
    rmSync(bob, { force: true });
    mkdirSync(bob, { recursive: true });
    expect(syncSignIn(files().bob)).toBe("copied");
    expect(readFileSync(bob, "utf8")).toBe(credentials("tok-3"));
  });

  describe("a copy that went bad is never taken back", () => {
    const claude = (access: string, refresh: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt } });
    const codex = (refresh: string, last: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: refresh }, last_refresh: last });

    it("a Claude file its CLI blanked after a refused renewal does not blank the team's login or the other audiences'", () => {
      write(team, claude("a1", "r1", Date.now() + 8 * 3_600_000));
      syncSignIn(files().bob);
      syncSignIn(files().owner);
      write(bob, claude("", "", 0), SETTLED_MS + 500);
      expect(syncSignIn(files().owner, [bob])).toBe("same");
      expect(readFileSync(team, "utf8")).toContain('"r1"');
      expect(syncSignIn(files().bob, [owner])).toBe("copied");
      expect(readFileSync(bob, "utf8")).toContain('"r1"');
    });

    it("a Claude copy renewed earlier than the team's is a stale one, however fresh its file", () => {
      write(team, claude("a2", "r2", Date.now() + 8 * 3_600_000), 5_000);
      write(bob, claude("a1", "r1", Date.now() + 1 * 3_600_000), SETTLED_MS + 500);
      syncSignIn(files().owner);
      expect(syncSignIn(files().owner, [bob])).toBe("same");
      expect(readFileSync(team, "utf8")).toContain('"r2"');
    });

    it("a Codex copy that lost its tokens, or holds an older renewal, never replaces the team's", () => {
      const teamAuth = join(root, "server", ".codex", "auth.json"), bobAuth = join(root, "bob", ".codex", "auth.json");
      const pair = { source: teamAuth, target: bobAuth };
      write(teamAuth, codex("r2", "2026-11-27T10:00:00Z"), 10_000);
      syncSignIn(pair);
      write(bobAuth, JSON.stringify({ auth_mode: "chatgpt", tokens: null }), SETTLED_MS + 500);
      expect(syncSignIn(pair)).toBe("copied");
      expect(readFileSync(teamAuth, "utf8")).toContain('"r2"');
      write(bobAuth, codex("r1", "2026-11-20T10:00:00Z"), SETTLED_MS + 500);
      expect(syncSignIn(pair)).toBe("copied");
      expect(readFileSync(teamAuth, "utf8")).toContain('"r2"');
      write(bobAuth, codex("r3", "2026-11-27T12:00:00Z"), SETTLED_MS + 500);
      expect(syncSignIn(pair)).toBe("taken back");
      expect(readFileSync(teamAuth, "utf8")).toContain('"r3"');
    });
  });
});
