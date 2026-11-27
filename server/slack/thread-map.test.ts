import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLACK_THREADS_FILE, SlackThreadMap } from "./thread-map.ts";

const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "slack-map-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const conversation = (botId = "bot", threadId = "thread") => ({ botId, threadId, channel: "C123", threadTs: "1.0", createdAt: 1 });

describe("SlackThreadMap", () => {
  it("persists conversations and posts with private permissions", () => {
    const dir = directory(), map = new SlackThreadMap(dir);
    map.setConversation("bot:ch:C123:1.0", conversation());
    map.notePosted("bot", "C123", "2.0", "thread", "message", 2);
    const loaded = new SlackThreadMap(dir);
    expect(loaded.conversation("bot:ch:C123:1.0")).toEqual(conversation());
    expect(loaded.posted("bot", "C123", "2.0")).toEqual({ threadId: "thread", messageId: "message", at: 2 });
    if (process.platform !== "win32") expect(statSync(join(dir, SLACK_THREADS_FILE)).mode & 0o777).toBe(0o600);
  });
  it("keeps the newest 5000 by at", () => {
    const dir = directory(), path = join(dir, SLACK_THREADS_FILE);
    const posted = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`bot:C:${i}`, { threadId: "t", messageId: `m${i}`, at: i }]));
    writeFileSync(path, JSON.stringify({ version: 1, conversations: {}, posted }));
    const map = new SlackThreadMap(dir);
    map.notePosted("bot", "C", "new", "t", "new", 9999);
    map.notePosted("bot", "C", "older", "t", "older", -1);
    expect(map.posted("bot", "C", "0")).toBeUndefined();
    expect(map.posted("bot", "C", "older")).toBeUndefined();
    expect(map.posted("bot", "C", "1")).toBeDefined();
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).posted)).toHaveLength(5000);
  });
  it("removes only the matching bot or thread, including post mappings", () => {
    const dir = directory(), map = new SlackThreadMap(dir);
    for (const [bot, thread] of [["a", "one"], ["a", "two"], ["b", "three"]]) {
      map.setConversation(`${bot}:im:${thread}`, conversation(bot, thread));
      map.notePosted(bot!, "C", thread!, thread!, "m", 1);
    }
    map.removeThread("one");
    expect(map.conversation("a:im:one")).toBeUndefined();
    expect(map.posted("a", "C", "one")).toBeUndefined();
    map.removeBot("a");
    const loaded = new SlackThreadMap(dir);
    expect(loaded.conversation("a:im:two")).toBeUndefined();
    expect(loaded.posted("a", "C", "two")).toBeUndefined();
    expect(loaded.conversation("b:im:three")).toBeDefined();
    expect(loaded.posted("b", "C", "three")).toBeDefined();
  });
  it.each(["not json", JSON.stringify({ version: 2, conversations: {}, posted: {} }), JSON.stringify({ version: 1, conversations: { x: {} }, posted: {} })])("quarantines an unreadable file with a fixed warning", (data) => {
    const dir = directory();
    writeFileSync(join(dir, SLACK_THREADS_FILE), data);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const map = new SlackThreadMap(dir);
    expect(map.conversation("x")).toBeUndefined();
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^slack-threads\.json\.unreadable-\d+$/)]);
    expect(warning).toHaveBeenCalledExactlyOnceWith("Slack conversation history could not be read. Starting empty.");
    map.setConversation("new", conversation());
    expect(new SlackThreadMap(dir).conversation("new")).toEqual(conversation());
  });
});
