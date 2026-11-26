import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encryptBrowserState } from "./browser-sites.ts";
import { McpOAuthStore, openMcpOAuthFile } from "./mcp-oauth-store.ts";

const URL_A = "https://mcp.example.com/mcp";
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-oauth-store-"));
  file = join(dir, "mcp-oauth.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("McpOAuthStore", () => {
  it("writes an owner-only file and reads a record back", () => {
    const store = new McpOAuthStore(file);
    store.put("docs", { url: URL_A, state: "signed-in", clientId: "c1", tokens: { access: "at", refresh: "rt", expiresAt: 5 } });
    // Windows has no POSIX permission bits; stat reports 0o666 there.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new McpOAuthStore(file).get("docs", URL_A)).toEqual({ url: URL_A, state: "signed-in", clientId: "c1", tokens: { access: "at", refresh: "rt", expiresAt: 5 } });
  });

  it("does not hand a record to a different URL", () => {
    const store = new McpOAuthStore(file);
    store.put("docs", { url: URL_A, state: "signed-in", tokens: { access: "at" } });
    expect(store.get("docs", "https://evil.example.com/mcp")).toBeUndefined();
  });

  it("deletes a record", () => {
    const store = new McpOAuthStore(file);
    store.put("docs", { url: URL_A, state: "needs-sign-in" });
    store.delete("docs");
    expect(store.get("docs", URL_A)).toBeUndefined();
  });

  it("opens a sealed file whose random nonce happens to start with a brace", () => {
    const key = "ab".repeat(32);
    const text = JSON.stringify({ servers: { docs: { url: URL_A, state: "signed-in", tokens: { access: "at" } } } });
    let sealed = encryptBrowserState(text, key);
    while (sealed[0] !== 0x7b) sealed = encryptBrowserState(text, key);
    writeFileSync(`${file}.key`, `${key}\n`, { mode: 0o600 });
    writeFileSync(file, sealed, { mode: 0o600 });
    expect(new McpOAuthStore(file).get("docs", URL_A)?.state).toBe("signed-in");
    expect(openMcpOAuthFile(file).servers.docs.state).toBe("signed-in");
  });

  it("still reads an old unsealed file beside a key", () => {
    writeFileSync(`${file}.key`, `${"cd".repeat(32)}\n`, { mode: 0o600 });
    writeFileSync(file, JSON.stringify({ servers: { docs: { url: URL_A, state: "needs-sign-in" } } }), { mode: 0o600 });
    expect(new McpOAuthStore(file).get("docs", URL_A)?.state).toBe("needs-sign-in");
  });

  it("reads a corrupt file as empty and leaves it until the next write", () => {
    writeFileSync(file, "{not json", { mode: 0o600 });
    const store = new McpOAuthStore(file);
    expect(store.get("docs", URL_A)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("{not json");
    store.put("docs", { url: URL_A, state: "needs-sign-in" });
    expect(store.get("docs", URL_A)?.state).toBe("needs-sign-in");
  });
});

describe("sealed on disk", () => {
  it("keeps tokens encrypted, reads a plain file from before and seals it on the next write", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "mcp-oauth-sealed-")), "mcp-oauth.json");
    writeFileSync(file, JSON.stringify({ servers: { composio: { url: "https://connect.composio.dev/mcp", state: "signed-in", tokens: { access: "plain-secret" } } } }));
    const store = new McpOAuthStore(file);
    expect(store.get("composio", "https://connect.composio.dev/mcp")?.tokens?.access).toBe("plain-secret");
    store.put("composio", { url: "https://connect.composio.dev/mcp", state: "signed-in", tokens: { access: "new-secret" } });
    expect(readFileSync(file).includes(Buffer.from("new-secret"))).toBe(false);
    expect(new McpOAuthStore(file).get("composio", "https://connect.composio.dev/mcp")?.tokens?.access).toBe("new-secret");
  });
});
