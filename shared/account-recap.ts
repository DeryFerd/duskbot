import type { WorkspaceReport } from "./dashboard-protocol.ts";

// What a person and their bots did together, for the cancel flow's recap: counts only, read from the reports their own
// workspaces send. Never message text, never routine names.

/** one bot as the recap draws it: its look and how many replies it gave in the window */
export interface RecapBot { id: string; name: string; color: string; body: string | null; replies: number }

export interface AccountRecap {
  v: 1;
  /** when the account was made (ms), for "together since" */
  since: number | null;
  /** bots across every workspace the account owns */
  bots: number;
  /** up to six bots for the scene, most replies first */
  crew: RecapBot[];
  /** the bot with the most replies in the window, when any replied */
  topBot: RecapBot | null;
  /** replies (turns) in the reports' window, the last 365 days */
  replies: number;
  /** days in the window with at least one reply, across workspaces */
  activeDays: number;
  /** the longest run of consecutive days with a reply */
  longestStreak: number;
  /** routines set up and switched on */
  routines: number;
  /** distinct apps connected on any workspace */
  apps: number;
  /** workspaces (computers and clouds) the account owns */
  computers: number;
}

export const EMPTY_RECAP: AccountRecap = { v: 1, since: null, bots: 0, crew: [], topBot: null, replies: 0, activeDays: 0, longestStreak: 0, routines: 0, apps: 0, computers: 0 };

/** GET: the signed-in account's recap (web session cookie or the app's bearer sign-in) -> AccountRecap */
export const ACCOUNT_RECAP_PATH = "/v1/account/recap";
const CREW_SIZE = 6;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** what the recap reads: the account's creation time and the latest report of each workspace it owns */
export interface AccountRecapInput {
  createdAt: number | null | undefined;
  workspaces: Array<{ report: Pick<WorkspaceReport, "bots" | "activity" | "apps"> | null | undefined }>;
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
function dayNumber(date: unknown): number | null {
  const match = typeof date === "string" ? DAY_KEY.exec(date) : null;
  if (!match) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(at) ? Math.round(at / 86_400_000) : null;
}

/** the recap from the reports alone: counts, bot looks and bot names, never message text or routine names. Older
 * workspaces may leave any section out. A bot reported by two workspaces counts once, its replies added up. */
export function accountRecap(input: AccountRecapInput): AccountRecap {
  const bots = new Map<string, RecapBot>(), routines = new Set<string>(), apps = new Set<string>(), days = new Set<number>();
  let replies = 0;
  for (const { report } of input.workspaces) {
    const activity = report?.activity, turnsByBot = new Map<string, number>();
    for (const row of activity?.byBot ?? []) turnsByBot.set(row.botId, (turnsByBot.get(row.botId) ?? 0) + count(row.turns));
    replies += count(activity?.totals?.turns);
    for (const day of activity?.days ?? []) {
      const at = count(day.turns) ? dayNumber(day.date) : null;
      if (at !== null) days.add(at);
    }
    for (const bot of report?.bots ?? []) {
      if (typeof bot?.id !== "string") continue;
      const seen = bots.get(bot.id), gave = turnsByBot.get(bot.id) ?? 0;
      if (seen) seen.replies += gave;
      else bots.set(bot.id, { id: bot.id, name: typeof bot.name === "string" ? bot.name : "", color: typeof bot.color === "string" ? bot.color : "blue", body: typeof bot.body === "string" ? bot.body : null, replies: gave });
      for (const routine of bot.routines ?? []) if (routine && !routine.paused) routines.add(`${bot.id}\n${routine.id}`);
    }
    for (const service of report?.apps?.services ?? []) if (service?.connected && typeof service.slug === "string") apps.add(service.slug);
  }
  const sorted = [...days].sort((a, b) => a - b);
  let longestStreak = 0, run = 0;
  sorted.forEach((day, i) => { run = i > 0 && day === sorted[i - 1]! + 1 ? run + 1 : 1; longestStreak = Math.max(longestStreak, run); });
  const crew = [...bots.values()].sort((a, b) => b.replies - a.replies || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1)).slice(0, CREW_SIZE);
  const since = typeof input.createdAt === "number" && Number.isFinite(input.createdAt) && input.createdAt > 0 ? input.createdAt : null;
  return { v: 1, since, bots: bots.size, crew, topBot: crew[0] && crew[0].replies > 0 ? { ...crew[0] } : null, replies, activeDays: days.size, longestStreak,
    routines: routines.size, apps: apps.size, computers: input.workspaces.length };
}
