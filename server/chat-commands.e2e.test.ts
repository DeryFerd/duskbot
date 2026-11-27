// /new, /compact and hours-away compaction on the real server with the fake Claude Code: sent as messages through the API
// (as the phone on an older app, a chat app or a script sends them), and the sweep that summarizes a chat the person
// left, run in seconds (DUSK_IDLE_COMPACT_HOURS 0.0005 = 1.8 s, DUSK_IDLE_SWEEP_MS, a floor the fake engine reaches).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlDusk } from "../scripts/control-dusk.ts";
import { request } from "../scripts/mcp-server.ts";

async function setup(env: NodeJS.ProcessEnv) {
  const session = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.270", ...env }, undefined, undefined, undefined, { scripted: true });
  const api = async (path: string, body?: unknown) =>
    await request(path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }, session.info.url) as any;
  const cli = async (...args: string[]) => await runControlDusk(args, { env: { DUSK_URL: session.info.url } }) as any;
  const bot = (await cli("new-bot", "--name", "Ledger")).bot;
  const plan = join(session.info.dataDir, "room-plan.json");
  writeFileSync(plan, JSON.stringify({ [bot.id]: { reply: "Noted." } }));
  const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages as any[];
  const send = async (threadId: string, text: string) => {
    await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
    expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
  };
  const idle = (threadId: string) => expect.poll(async () => (await api("/api/bots?messages=0")).bots
    .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === threadId)?.busy, { timeout: 15_000 }).toBe(false);
  const turns = () => existsSync(`${plan}.evidence.jsonl`) ? readFileSync(`${plan}.evidence.jsonl`, "utf8")
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const log = () => readFileSync(session.info.logPath, "utf8");
  return { session, api, cli, bot, messages, send, idle, turns, log };
}

it("/compact with a focus and /new act on the conversation, never reach the bot as words, and a retry starts nothing twice", async () => {
  const f = await setup({ DUSK_IDLE_COMPACT_HOURS: "0" });
  try {
    const thread = f.bot.activeTaskId;
    await f.send(thread, "The vendor contact is Tomasz, tomasz@nordlane.io");
    await f.send(thread, "Depot codes: Antwerp BEA-01, Duisburg DED-04");
    await f.send(thread, "Next step is validating the mapping");
    const turnsBefore = f.turns().length;

    const compacted = await f.api(`/api/bots/${f.bot.id}/messages`, { threadId: thread, text: "/compact keep the vendor contact and depot codes", sendId: randomUUID() });
    expect(compacted).toMatchObject({ ok: true, threadId: thread, command: "compact" });
    await f.idle(thread);
    const record = (await f.messages(thread)).at(-1);
    expect(record.kind).toBe("compaction");
    expect(record.compaction.by).toBe("person");
    expect(record.compaction.summary).toContain("tomasz@nordlane.io");
    expect((await f.messages(thread)).some((m) => m.role === "user" && (m.text ?? "").startsWith("/compact"))).toBe(false);
    expect(f.turns()).toHaveLength(turnsBefore);

    const newSend = randomUUID();
    const fresh = await f.api(`/api/bots/${f.bot.id}/messages`, { threadId: thread, text: "/new", sendId: newSend });
    expect(fresh).toMatchObject({ ok: true, command: "new", fresh: true });
    expect(fresh.threadId).not.toBe(thread);
    // the same send again (a retry) answers alike and makes no second chat
    expect(await f.api(`/api/bots/${f.bot.id}/messages`, { threadId: thread, text: "/new", sendId: newSend })).toEqual(fresh);
    const bots = (await f.api("/api/bots?messages=0")).bots;
    const tasks = bots.find((b: any) => b.id === f.bot.id).tasks;
    expect(tasks.filter((t: any) => !t.routineRunId)).toHaveLength(2);
    // the old chat stays as it was, and was never sent "/new"
    const old = await f.messages(thread);
    expect(old.at(-1)).toMatchObject({ kind: "compaction" });
    expect(old.some((m) => m.role === "user" && m.text === "/new")).toBe(false);
    // a /new in a chat with nothing said yet keeps it
    expect(await f.api(`/api/bots/${f.bot.id}/messages`, { threadId: fresh.threadId, text: "/new" })).toMatchObject({ threadId: fresh.threadId, fresh: false });
    // the new chat starts clean: its first turn carries no earlier summary
    await f.send(fresh.threadId, "What's on today?");
    const first = f.turns().at(-1);
    expect(String(first.prompt.message.content)).not.toContain("Earlier conversation summary");
    expect(first.resumed).toBe(false);
  } finally { await f.session.close(); }
}, 120_000);

it("summarizes a chat the person left in the background, then the next message starts from the summary", async () => {
  const f = await setup({ DUSK_IDLE_COMPACT_HOURS: "0.0005", DUSK_IDLE_SWEEP_MS: "400", DUSK_IDLE_COMPACT_MIN_TOKENS: "1" });
  try {
    const thread = f.bot.activeTaskId;
    await f.send(thread, "My budget for the trip is 2,400 EUR");
    await f.send(thread, "Book hotels near the old town");
    await f.send(thread, "Keep flights under 300 EUR each");
    await f.send(thread, "Thanks, that's all for now");
    // away: the sweep summarizes it, keeping the last two exchanges word for word
    await expect.poll(async () => (await f.messages(thread)).findLast((m) => m.kind === "compaction")?.compaction?.awayHours, { timeout: 20_000 }).toBe(0.0005);
    const record = (await f.messages(thread)).findLast((m) => m.kind === "compaction");
    expect(record.compaction.by).toBe("harness");
    expect(record.compaction.summary).toContain("2,400 EUR");
    expect(f.log()).toMatch(/idle compaction .*: summarized after 0\.0005 h away/);
    // once per absence: no second summary while nobody writes
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await f.messages(thread)).filter((m) => m.kind === "compaction")).toHaveLength(1);
    await f.send(thread, "Back. What was my budget again?");
    const next = f.turns().at(-1);
    expect(next.resumed).toBe(false);
    const prompt = String(next.prompt.message.content);
    expect(prompt).toContain("Earlier conversation summary");
    expect(prompt).toContain("2,400 EUR");
    expect(prompt).toContain("look it up with session_search");
    expect(prompt).toContain("Keep flights under 300 EUR each");
  } finally { await f.session.close(); }
}, 120_000);
