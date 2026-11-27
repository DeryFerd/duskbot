// What memory_update's forget tells the bot: the facts it removed and every place they went (its memory, the person's
// other bots, About me, daily log lines), and that chats still hold what was said, so it never claims more than it did.
import type { Json } from "./agents-client.ts";

const FORGOTTEN_SHOWN = 8;

export function forgetText(passage: string, r: Json): string {
  const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const notes = list(r.forgotten);
  const aboutMe = list(r.aboutMe);
  const others = list(r.otherBots);
  const logLines = typeof r.logLines === "number" && r.logLines > 0 ? r.logLines : 0;
  // an older server sends neither field: its forget reached this bot's memory only
  const own = r.ownMemory === true || (r.ownMemory === undefined && notes.length > 0);
  if (!notes.length && !aboutMe.length && !logLines && !others.length) {
    return `Nothing saved mentions ${JSON.stringify(passage)}: not in your notes, not in About me. Try other words for it once; if nothing matches, tell the person it was not saved.`;
  }
  const where = [...(own ? ["your memory"] : []), ...others.map((name) => `${name}'s memory`), ...(aboutMe.length ? ["About me (which all their bots read)"] : [])];
  const logs = `${logLines} daily log ${logLines === 1 ? "line" : "lines"}`;
  const facts = [...new Set([...notes, ...aboutMe])];
  const shown = facts.slice(0, FORGOTTEN_SHOWN).map((fact) => JSON.stringify(fact)).join(", ");
  const more = facts.length > FORGOTTEN_SHOWN ? ` and ${facts.length - FORGOTTEN_SHOWN} more` : "";
  const what = facts.length ? `${logLines ? `, ${logs} included` : ""}: ${shown}${more}` : `: ${logLines ? logs : "the lines"} that named ${JSON.stringify(passage)}`;
  return `Forgotten from ${andList(where)}${what}. Their chats still show what was said in them; don't bring it back from there. Confirm to the person in one plain line what you forgot.`;
}

/** "a", "a and b", "a, b and c". */
const andList = (items: readonly string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";
