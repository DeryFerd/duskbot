// A bot's session settings: when its direct chats start fresh by themselves and where they compact.
export type FreshSession = { every: "day" } | { idleHours: number };
export type FreshKind = "day" | "idle";
export const FRESH_SESSION_IDLE_HOURS = [6, 24] as const;
export const FRESH_SESSION_MAX_IDLE_HOURS = 24 * 30;
/** The choices the bot's settings offer; the server takes any fraction from 0.3 to 0.9. */
export const COMPACT_AT_CHOICES = [0.5, 0.7, 0.9] as const;
export const COMPACT_AT_MIN = 0.3;
export const COMPACT_AT_MAX = 0.9;

export interface SessionSettingsFields {
  /** When a direct chat starts a fresh session by itself, silently: the person's first message of a new day (from 4 am
   * in their time zone) or after `idleHours` without one starts the bot's context empty; the chat stays as it was and
   * session_search still finds it. Absent: never. */
  freshSession?: FreshSession;
  /** How full the model's context gets before the chat is compacted by itself, as a fraction of its window. Absent:
   * config.json's `context.compactAt`, else 80% and at most 200,000 tokens. */
  compactAt?: number;
}
