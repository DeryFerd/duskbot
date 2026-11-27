import { describe, expect, it } from "vitest";
import { accountRecap, EMPTY_RECAP, type AccountRecapInput } from "./account-recap.ts";
import type { ActivityReport, BotReport } from "./dashboard-protocol.ts";

type Report = NonNullable<AccountRecapInput["workspaces"][number]["report"]>;
const totals = (turns: number) => ({ turns, tokens: turns * 100, costUsd: null });
const routine = (id: string, name: string, paused = false) => ({ id, name, schedule: "Every day at 8:00", paused, nextRunAt: null, lastRunAt: null });
const bot = (id: string, name: string, extra: Partial<BotReport> = {}): BotReport =>
  ({ id, name, color: "blue", body: null, model: null, engine: null, computer: null, busy: false, lastActiveAt: null, routines: [], ...extra });
function activity(days: Array<[string, number]>, byBot: Array<[string, number]> = []): ActivityReport {
  const turns = days.reduce((sum, [, n]) => sum + n, 0);
  return { from: "2025-11-28", to: "2026-11-27", timeZone: "UTC", days: days.map(([date, n]) => ({ date, ...totals(n) })),
    byBot: byBot.map(([botId, n]) => ({ botId, botName: botId, ...totals(n) })), byModel: [], totals: totals(turns) };
}
const recap = (createdAt: number | null, ...reports: Array<Report | null>) => accountRecap({ createdAt, workspaces: reports.map(report => ({ report })) });

describe("accountRecap", () => {
  it("is the empty recap with no workspaces, and only counts a workspace with no report", () => {
    expect(recap(null)).toEqual(EMPTY_RECAP);
    expect(recap(1_700_000_000_000, null)).toEqual({ ...EMPTY_RECAP, since: 1_700_000_000_000, computers: 1 });
  });

  it("finds the longest streak across a gap and across a month end, and skips days with no replies", () => {
    const answer = recap(null, { activity: activity([["2026-01-30", 2], ["2026-01-31", 1], ["2026-02-01", 4], ["2026-02-02", 0], ["2026-02-03", 5], ["2026-02-10", 1], ["2026-02-11", 1]]) });
    expect(answer).toMatchObject({ replies: 14, activeDays: 6, longestStreak: 3 });
  });

  it("joins days across two workspaces: a shared day counts once and a neighbour's day extends the streak", () => {
    const answer = recap(null, { activity: activity([["2026-03-01", 3], ["2026-03-02", 1]]) }, { activity: activity([["2026-03-02", 2], ["2026-03-03", 9], ["2026-03-05", 1]]) });
    expect(answer).toMatchObject({ replies: 16, activeDays: 4, longestStreak: 3, computers: 2 });
  });

  it("counts routines that are switched on, never paused ones", () => {
    const answer = recap(null, { bots: [bot("a", "Ada", { routines: [routine("r1", "Morning brief"), routine("r2", "Secret plan", true)] }), bot("b", "Bo", { routines: [routine("r1", "Weekly review")] })] });
    expect(answer.routines).toBe(2);
  });

  it("counts each connected app once across workspaces, never pending or disconnected ones", () => {
    const apps = (services: Array<[string, boolean]>) => ({ available: true, complete: true, services: services.map(([slug, connected]) => ({ slug, connected, pending: !connected })) });
    expect(recap(null, { apps: apps([["gmail", true], ["github", true], ["linear", false]]) }, { apps: apps([["gmail", true], ["notion", true]]) }).apps).toBe(3);
  });

  it("puts up to six bots in the crew by replies then name, and names the top bot only when one replied", () => {
    const names = ["Hal", "Gus", "Fay", "Eve", "Dot", "Cy", "Bea"];
    const quiet = recap(null, { bots: names.map((name, i) => bot(`b${i}`, name)) });
    expect(quiet.bots).toBe(7);
    expect(quiet.crew.map(item => item.name)).toEqual(["Bea", "Cy", "Dot", "Eve", "Fay", "Gus"]);
    expect(quiet.topBot).toBeNull();
    const busy = recap(null, { bots: [bot("a", "Ada", { color: "purple", body: "clover" }), bot("b", "Bo"), bot("c", "Cid")], activity: activity([["2026-04-01", 12]], [["b", 9], ["a", 3], ["gone", 4]]) });
    expect(busy.crew).toEqual([{ id: "b", name: "Bo", color: "blue", body: null, replies: 9 }, { id: "a", name: "Ada", color: "purple", body: "clover", replies: 3 }, { id: "c", name: "Cid", color: "blue", body: null, replies: 0 }]);
    expect(busy.topBot).toEqual(busy.crew[0]);
  });

  it("joins a bot's replies from its own workspace, and counts a bot two workspaces report once", () => {
    const answer = recap(null, { bots: [bot("a", "Ada")], activity: activity([["2026-05-01", 5]], [["a", 5]]) }, { bots: [bot("a", "Ada"), bot("z", "Zed")], activity: activity([["2026-05-02", 7]], [["z", 4], ["a", 3]]) });
    expect(answer.bots).toBe(2);
    expect(answer.crew.map(item => [item.id, item.replies])).toEqual([["a", 8], ["z", 4]]);
  });

  it("tolerates older workspaces that leave sections out, and never carries routine names or message text", () => {
    const old = { bots: [{ ...bot("a", "Ada"), routines: undefined } as unknown as BotReport], activity: { ...activity([["2026-06-01", 2]]), byBot: undefined, days: undefined } as unknown as ActivityReport };
    const answer = recap(Number.NaN, old, { apps: { available: false, complete: true, services: [] } }, null);
    expect(answer).toEqual({ ...EMPTY_RECAP, bots: 1, crew: [{ id: "a", name: "Ada", color: "blue", body: null, replies: 0 }], replies: 2, computers: 3 });
    const named = JSON.stringify(recap(null, { bots: [bot("a", "Ada", { routines: [routine("r1", "Call mum about the lawyer")] })] }));
    expect(named).not.toContain("lawyer");
  });
});
