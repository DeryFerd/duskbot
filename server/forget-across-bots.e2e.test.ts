// "Forget" in one bot's chat reaches the same person's memory with every other bot: the scripted Scout forgets through
// the real agents tool and server route, then Pepper's notes, daily log and session_search no longer have it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlDusk } from "../scripts/control-dusk.ts";

type Step = { tool: string; arguments: Record<string, unknown> };

it("one bot's forget clears the fact from another bot's notes, daily log and session_search, and says where it went", async () => {
  const fixture = await launchVerificationServer({ ...process.env, TZ: "Asia/Kolkata" }, undefined, undefined, undefined, { scripted: true });
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const api = async <T = any>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(200);
    return response.json() as Promise<T>;
  };
  const cli = (...args: string[]) => runControlDusk([...args, "--url", fixture.info.url]) as Promise<any>;
  // one scripted turn per message, run once: a later run of the same bot (a recovery that finishes the job, its memory
  // learner) gets no steps, so nothing is saved twice behind the test's back
  const scripts: Record<string, Array<Record<string, unknown>>> = {};
  const turn = async (bot: { id: string; activeTaskId: string }, text: string, steps: Step[], reply: string) => {
    const key = `${bot.id}:${(scripts[bot.id] ?? []).length}`;
    scripts[bot.id] = [...(scripts[bot.id] ?? []).filter((entry) => !entry.repeat), { key, match: [text], steps, reply }, { key: "rest", match: [], repeat: true, steps: [], reply: "Done." }];
    writeFileSync(planPath, JSON.stringify(Object.fromEntries(Object.entries(scripts).map(([id, script]) => [id, { script }]))));
    const ran = () => evidence().find((row) => row.planKey === key);
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
    await expect.poll(() => Boolean(ran()), { timeout: 45_000, message: `${bot.id} ran "${text}"` }).toBe(true);
    // settled: a follow-up run the server starts on its own (finishing the job) has ended too, so the next message
    // starts a turn of its own instead of steering into that one
    for (let seen = -1; seen !== evidence().length;) {
      seen = evidence().length;
      await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20");
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    return (ran().evidence as Array<{ step?: Step; response: any }>).filter((entry) => entry.step).map((entry) => String(entry.response?.result?.content?.[0]?.text ?? ""));
  };
  const notes = async (botId: string) => (await api<{ text: string }>(`/api/bots/${botId}/memory/file?path=MEMORY.md`)).text;
  try {
    const { bot: scout } = await cli("new-bot", "--name", "Scout");
    const { bot: pepper } = await cli("new-bot", "--name", "Pepper");
    // each new bot's hello runs unattended first; a message sent into it would not count as the person's own
    for (const bot of [scout, pepper]) await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20");
    await turn(scout, "Remember: my sister Meera's birthday is March 14, and my staging server is kestrel-02.", [
      { tool: "memory_update", arguments: { action: "append", text: "Meera's birthday is March 14" } },
      { tool: "memory_update", arguments: { action: "append", text: "The staging server is kestrel-02" } },
    ], "Saved both.");
    // what Pepper kept after answering from Scout's chat earlier that day (QA evidence C-07)
    await turn(pepper, "Remember I live in Pune.", [
      { tool: "memory_update", arguments: { action: "append", text: "The person lives in Pune" } },
      { tool: "memory_update", arguments: { action: "append", text: "Meera's birthday is March 14" } },
    ], "Saved.");
    const logDir = join(fixture.info.dataDir, "workspaces", pepper.id, "memory", "log");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "2026-11-26.md"), "# 2026-11-26\n- 18:24 · from chat \"what's my staging server called a…\" · Staging server: kestrel-02 - Meera's birthday: March 14 - You live in Pune\n- 18:30 · Booked the dentist for Friday\n");
    expect(await notes(pepper.id)).toContain("Meera's birthday");

    const forgot = await turn(scout, "Please forget Meera's birthday.", [
      { tool: "memory_update", arguments: { action: "forget", old_text: "Meera's birthday" } },
    ], "Done, forgotten.");
    expect(await notes(scout.id)).not.toContain("Meera");
    expect(await notes(scout.id)).toContain("kestrel-02");
    expect(await notes(pepper.id)).not.toContain("Meera");
    expect(await notes(pepper.id)).toContain("lives in Pune");
    expect(readFileSync(join(logDir, "2026-11-26.md"), "utf8")).toBe("# 2026-11-26\n- 18:30 · Booked the dentist for Friday\n");
    expect(forgot[0]).toBe('Forgotten from your memory and Pepper\'s memory, 1 daily log line included: "Meera\'s birthday is March 14". Their chats still show what was said in them; don\'t bring it back from there. Confirm to the person in one plain line what you forgot.');

    const searched = await turn(pepper, "When is Meera's birthday?", [
      { tool: "session_search", arguments: { query: "Meera birthday", scope: "memory" } },
    ], "I don't have that.");
    expect(searched[0]).toMatch(/\S/);
    expect(searched[0]).not.toContain("March 14");
  } finally {
    await fixture.close();
  }
}, 240_000);
