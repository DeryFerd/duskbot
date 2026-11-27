import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

import { searchMessagesInDatabase } from "./message-search-query.ts";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE messages (thread_id TEXT, id TEXT, at INTEGER, role TEXT, kind TEXT, text TEXT, json TEXT)");
  const add = (id: string, kind: string, text: string | null, tool?: string) =>
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run("t", id, 1, "bot", kind, text, JSON.stringify(tool ? { tool: { name: tool } } : {}));
  add("note", "activity", null, "recovery: New session started");
  add("tool", "activity", null, "Searched the session list");
  add("said", "text", "the session notes");
  return db;
}

it("finds what was said and the tools that ran, never the app's own recovery notes", () => {
  expect(searchMessagesInDatabase(database(), "session").map((hit) => hit.messageId).sort()).toEqual(["said", "tool"]);
});
