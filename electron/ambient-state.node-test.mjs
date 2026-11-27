import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SEEN, applyPrefsChange, parseAct, parsePrefs, parseSnapshot, seenKeys } from "./ambient-state.mjs";

const bot = (fields = {}) => ({ id: "nova", threadId: "t1", name: "Nova", color: "blue", status: "working", line: "Hi", at: 5, ...fields });

test("a summary keeps only the shapes the surfaces draw, each line cut short", () => {
  const parsed = parseSnapshot({
    lang: "de",
    labels: { idle: "Untätig", "bad key!": "x", working: "Arbeitet".repeat(40) },
    bots: [
      bot({ extra: "secret", line: "a ".repeat(400), avatar: "/api/avatars/nova.png", approval: { requestId: "r1", threadId: "t1", title: "Run npm test", more: 1 } }),
      bot(),
      bot({ id: "../etc", threadId: "t2" }),
      bot({ id: "quill", threadId: "t3", color: "neon", status: "dancing", avatar: "https://evil.example/x.png", body: "<svg>", asks: 1e9 }),
      "nope",
    ],
  });
  assert.equal(parsed.lang, "de");
  assert.deepEqual(Object.keys(parsed.labels), ["idle", "working"]);
  assert.equal(parsed.labels.working.length, 160);
  assert.deepEqual(parsed.bots.map((entry) => entry.id), ["nova", "quill"]);
  const [nova, quill] = parsed.bots;
  assert.equal(nova.extra, undefined);
  assert.equal(nova.line.length, 240);
  assert.equal(nova.avatar, "/api/avatars/nova.png");
  assert.deepEqual(nova.approval, { requestId: "r1", threadId: "t1", title: "Run npm test" });
  assert.deepEqual([quill.color, quill.status, quill.avatar, quill.body, quill.asks], ["green", "idle", null, null, 99]);
  const asked = parseSnapshot({ bots: [
    bot({ waits: "question", question: { requestId: "q1", threadId: "t1", title: "Which branch?", choices: ["main", "dev", "", "a", "b", "c"], extra: 1 } }),
    bot({ id: "echo", waits: "everything", question: { requestId: "q 2", threadId: "t1", choices: ["x"] } }),
    bot({ id: "lark", question: { requestId: "q3", threadId: "t1", choices: [] } }),
    bot({ id: "wren", waits: "sign-in", step: "web", question: { requestId: "q4", threadId: "t1", title: "Which city?", choices: [], custom: true } }),
  ] }).bots;
  assert.deepEqual(asked.map((entry) => [entry.waits, entry.question]), [
    ["question", { requestId: "q1", threadId: "t1", title: "Which branch?", choices: ["main", "dev", "a"], custom: false }],
    [null, null],
    [null, null],
    ["sign-in", { requestId: "q4", threadId: "t1", title: "Which city?", choices: [], custom: true }],
  ]);
  assert.deepEqual(asked.map((entry) => entry.step), [null, null, null, "web"]);
  assert.equal(parseSnapshot({ bots: "x" }), null);
  assert.equal(parseSnapshot(null), null);
});

test("the surfaces may only ask to reply, allow, deny, answer, stop or make a bot", () => {
  assert.deepEqual(parseAct({ kind: "answer", botId: "nova", threadId: "t1", requestId: "q1", text: " main " }), { kind: "answer", botId: "nova", threadId: "t1", requestId: "q1", text: "main" });
  // a typed answer may be longer than a choice; the app's page decides whether the question takes one
  assert.equal(parseAct({ kind: "answer", botId: "nova", threadId: "t1", requestId: "q1", text: "x".repeat(5000) }).text.length, 2000);
  assert.equal(parseAct({ kind: "answer", botId: "nova", threadId: "t1", text: "main" }), null);
  assert.equal(parseAct({ kind: "answer", botId: "nova", threadId: "t1", requestId: "q1", text: " " }), null);
  assert.deepEqual(parseAct({ kind: "stop", botId: "nova", threadId: "t1", text: "x" }), { kind: "stop", botId: "nova", threadId: "t1" });
  assert.equal(parseAct({ kind: "stop", botId: "nova" }), null);
  assert.deepEqual(parseAct({ kind: "reply", botId: "nova", threadId: "t1", text: "  on it  " }), { kind: "reply", botId: "nova", threadId: "t1", text: "on it" });
  assert.equal(parseAct({ kind: "reply", botId: "nova", threadId: "t1", text: "   " }), null);
  assert.deepEqual(parseAct({ kind: "allow", botId: "nova", threadId: "t1", requestId: "r1", text: "x" }), { kind: "allow", botId: "nova", threadId: "t1", requestId: "r1" });
  assert.equal(parseAct({ kind: "deny", botId: "nova", threadId: "t1" }), null);
  assert.deepEqual(parseAct({ kind: "new-bot", botId: "x" }), { kind: "new-bot" });
  assert.equal(parseAct({ kind: "delete", botId: "nova", threadId: "t1" }), null);
  assert.equal(parseAct({ kind: "reply", botId: "a b", threadId: "t1", text: "hi" }), null);
});

test("both surfaces start on only on macOS, and a change keeps to the known choices", () => {
  assert.deepEqual(parsePrefs(null, "darwin"), { island: true, dock: true, size: "medium", display: "active", order: [], seen: [] });
  assert.deepEqual([parsePrefs(null, "win32").island, parsePrefs(null, "win32").dock], [false, false]);
  assert.deepEqual([parsePrefs({ island: true, dock: true }, "linux").island, parsePrefs({ island: true, dock: true }, "linux").dock], [false, true]);
  assert.equal(parsePrefs({ island: false }, "darwin").island, false);
  const prefs = parsePrefs(null, "darwin");
  const changed = applyPrefsChange(prefs, { size: "large", display: "built-in", island: false, order: ["b", "a", "b", "../x"], evil: 1, seen: ["x:done:1"] }, "darwin");
  assert.deepEqual(changed, { island: false, dock: true, size: "large", display: "built-in", order: ["b", "a"], seen: [] });
  assert.deepEqual(applyPrefsChange(prefs, { size: "giant", display: "left" }, "darwin"), prefs);
});

test("seen replies and failures are kept by key, newest last, capped, and nothing else gets in", () => {
  assert.deepEqual(seenKeys(["nova:done:5", "nova:done:5", "../x", 4, "echo:error:9"]), ["nova:done:5", "echo:error:9"]);
  const many = Array.from({ length: MAX_SEEN + 20 }, (_, index) => `b:done:${index}`);
  assert.equal(seenKeys(many).length, MAX_SEEN);
  assert.equal(seenKeys(many).at(-1), `b:done:${MAX_SEEN + 19}`);
  assert.deepEqual(parsePrefs({ v: 2, seen: ["a:error:1"] }, "darwin").seen, ["a:error:1"]);
});

test("a bot's chat keeps its newest messages, lines kept and each cut short, the reply it streams, and a whole summary stays bounded", () => {
  const chat = [...Array.from({ length: 130 }, (_, index) => ({ id: `m${index}`, from: index % 2 ? "you" : "bot", text: `line ${index}`, at: index + 1 })),
    { id: "x", from: "admin", text: `first\n\n  second  line\n${"y".repeat(3000)}`, at: 200, html: "<b>" }, { id: "z", from: "bot", text: "   " }, "nope"];
  const [parsed] = parseSnapshot({ bots: [bot({ chat, streaming: "  Looking   at\nflights ", hasMore: true })] }).bots;
  assert.equal(parsed.chat.length, 118);
  assert.deepEqual(Object.keys(parsed.chat.at(-1)), ["id", "from", "text", "at"]);
  assert.equal(parsed.chat.at(-1).from, "bot");
  assert.ok(parsed.chat.at(-1).text.startsWith("first\nsecond line\n"));
  assert.equal(parsed.chat.at(-1).text.length, 2000);
  assert.equal(parsed.streaming, "Looking at\nflights");
  assert.equal(parsed.hasMore, true);
  assert.deepEqual(parseSnapshot({ bots: [bot({ chat: "x" })] }).bots[0].chat, []);
  // forty bots with long chats: never more than 400 messages in one summary
  const many = parseSnapshot({ bots: Array.from({ length: 10 }, (_, index) => bot({ id: `b${index}`, threadId: `t${index}`, chat })) }).bots;
  assert.equal(many.reduce((sum, entry) => sum + entry.chat.length, 0), 400);
});
