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
