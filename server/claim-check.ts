// A reply that says something was sent, saved, scheduled, set up or removed is held to the calls its turn ran: each kind
// of claim needs a successful call that could have done that kind of thing. The chat loop sends an unbacked claim back
// inside the turn; the finish guard does the same for engines that own their loop.
import { isClientCancellation } from "../shared/client-cancel.ts";
import { isOutboundTool } from "../shared/outbound.ts";
import { BRIDGE_TOOL } from "./drivers/openai-chat-habits.ts";

export type Deed = "send" | "schedule" | "save" | "remove" | "setup";
type Evidence = Deed | "browser" | "shell" | "other";

const BACKED_BY: Record<Deed, readonly Evidence[]> = {
  send: ["send", "browser"],
  schedule: ["schedule", "browser"],
  save: ["save", "browser", "shell"],
  remove: ["remove", "browser", "shell"],
  setup: ["schedule", "save", "remove", "browser", "shell", "other"],
};

const SUBJECT = String.raw`(?:^|[,;:]\s*|\band\s+|\b(?:i|i['’]ve|i have|we|we['’]ve|we have)\s+(?:just\s+|now\s+|also\s+|already\s+|successfully\s+)*)`;
const PASSIVE = String.raw`\b(?:has been|have been|was|were|is now|are now|is|are|got)\s+(?:now\s+|already\s+|successfully\s+)*`;
const VERBS: Record<Exclude<Deed, "setup">, string> = {
  send: "sent|emailed|messaged|replied|posted|forwarded|texted|published|shared|pinged|notified|passed (?:it |this |that |them )?(?:on|along)",
  schedule: "scheduled|rescheduled|booked|reserved|invited|added (?:it |this |that )?to (?:your |the )?calendar",
  save: "saved|created|wrote|written|filed|logged|exported|uploaded|stored|recorded|noted down|made (?:the |a |your )?(?:note|doc|document|file|sheet|page)",
  remove: "deleted|removed|forgot|forgotten|erased|cleared|cancell?ed|archived|unsubscribed|trashed",
};
const SETUP = String.raw`\bset up\b|\bturned (?:on|off)\b|\bpaused\b|\b(?:is|are) now (?:on|live|active|running)\b|^set up[.!]`;
const READY = /\b(?:notes?|doc(?:ument)?s?|files?|sheets?|spreadsheets?|pages?|briefing|brief|prep|one-pager)\b[^.!?\n:]{0,40}\b(?:is|are) (?:now )?(?:ready|saved|in your)\b(?![^.!?\n]{0,30}(?:below|here|in (?:this|the) chat))(?![^.!?\n]*:\s*$)/i;
/** A sentence that offers, plans, asks, quotes or denies claims nothing. */
const NOT_A_CLAIM = /\b(?:not|never|no|nothing|haven['’]?t|hasn['’]?t|didn['’]?t|wasn['’]?t|weren['’]?t|isn['’]?t|couldn['’]?t|can['’]?t|cannot|won['’]?t|wouldn['’]?t|would|will|could|should|can|shall|might|ready to|about to|want me|if you|once you|when you|after you|before|draft(?:ed|s)?|earlier|yesterday|last (?:week|time|night)|already (?:been|was))\b|\?/i;
/** "Sent you the summary above" is this chat's own reply, not an outside send. */
const TO_THIS_CHAT = /\b(?:sent|messaged|shared|posted|replied)\s+(?:to\s+)?you\b|\b(?:above|below|here)\b/i;
/** "Created a reminder" is scheduling, not saving. */
const LATER_WORK = /\b(?:reminders?|routines?|automations?|triggers?|watch(?:er)?|alerts?|check-?ins?|schedules?)\b/i;
/** "the time when this message was sent" says when, not that the bot did it; the clause goes, the rest still counts. */
const WHEN_CLAUSE = /\bwhen\s+(?:[\w'’-]+\s+){0,3}(?:was|were)\s+(?:just\s+|already\s+)?[\w-]+/gi;
const QUOTED = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|^>.*$/gm;

const sentences = (text: string) => text.replace(QUOTED, " ").split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);

/** The kinds of outside change a reply says it made. */
export function claimedDeeds(text: string): Deed[] {
  const found = new Set<Deed>();
  // a gateway's "The request was cancelled by the client." stops the turn; it is not the bot saying it cancelled something
  if (isClientCancellation(text)) return [];
  for (const whole of sentences(text)) {
    const sentence = whole.replace(WHEN_CLAUSE, " ");
    if (NOT_A_CLAIM.test(sentence)) continue;
    for (const [deed, verbs] of Object.entries(VERBS) as Array<[Deed, string]>) {
      if (deed === "send" && TO_THIS_CHAT.test(sentence)) continue;
      if (new RegExp(`${SUBJECT}(?:done[,:]?\\s+)?(?:${verbs})\\b|${PASSIVE}(?:${verbs})\\b`, "i").test(sentence)) found.add(deed === "save" && LATER_WORK.test(sentence) ? "schedule" : deed);
    }
    if (new RegExp(SETUP, "i").test(sentence)) found.add("setup");
    if (READY.test(sentence)) found.add("save");
  }
  return [...found];
}

const BROWSER = /(?:^|_)(?:browser_(?:click|fill|type|press|select|check|upload|batch|drag)|computer_\w+|click|type_text)$/;
const SHELL = /^(?:bash|shell|exec|exec_command|run_command|run_shell|vm_exec|terminal|local_shell|apply_patch)$/;
const SEND = /(?:send|reply|forward|post|publish|share|comment|notify|message|email|tweet|coordinate_bots|start_thread|hand_?off)/;
const SCHEDULE = /(?:event|calendar|book|reserv|schedul|invite|appointment|meeting|remind|routine|trigger|wait_until|watcher|background_job)/;
const REMOVE = /(?:delete|remove|forget|cancel|archive|trash|unsubscribe|clear|refund|revoke|leave)/;
const SAVE = /(?:write|create|save|update|edit|append|add|insert|upload|note|file|doc|sheet|log|patch|apply|set|put|rename|move|draft|label|modify)/;

function argsOf(rawArgs: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = rawArgs ? JSON.parse(rawArgs) : null;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** What one successful call that could change something may have done, by its tool name (a bridged `use_tool` or `call_tool`
 * call by the tool it ran) and, for memory, its action. */
export function callEvidence(name: string, rawArgs?: string): Evidence[] {
  let args = argsOf(rawArgs);
  let tool = name;
  if (BRIDGE_TOOL.test(name) && typeof args.name === "string") {
    tool = args.name;
    args = args.arguments && typeof args.arguments === "object" ? args.arguments as Record<string, unknown> : {};
  }
  const bare = tool.split("__").at(-1)!.toLowerCase();
  if (BROWSER.test(bare)) return ["browser"];
  if (SHELL.test(bare)) return ["shell"];
  if (/^memory_update$/.test(bare)) return args.action === "forget" || args.action === "remove" ? ["remove"] : ["save"];
  const found = new Set<Evidence>();
  if ((isOutboundTool(tool) || SEND.test(bare)) && !/draft/.test(bare)) found.add("send");
  if (SCHEDULE.test(bare)) found.add("schedule");
  if (REMOVE.test(bare)) found.add("remove");
  if (SAVE.test(bare)) found.add("save");
  return found.size ? [...found] : ["other"];
}

export function unbackedDeeds(claims: readonly Deed[], evidence: ReadonlySet<string>): Deed[] {
  return claims.filter((deed) => !BACKED_BY[deed].some((proof) => evidence.has(proof)));
}

const WORDS: Record<Deed, string> = { send: "sent", schedule: "scheduled or booked", save: "saved or ready", remove: "removed or deleted", setup: "set up" };

export function unbackedClaimNote(deeds: readonly Deed[]): string {
  const what = deeds.map((deed) => WORDS[deed]).join(", ");
  const save = deeds.includes("save") ? " When they asked for notes, a document or a file to be ready, save it where they keep such things (their notes app, a document) and say where it is." : "";
  return `[dusk bot: your reply says something was ${what}, but no tool call in this turn did that, so it did not happen. If the person asked for it and a tool can do it, do it now and check its result, then answer in one short line.${save} Otherwise rewrite the reply to say plainly what was not done and what is ready instead (a draft, the text in this chat), without claiming it is done. Never repeat a step that already succeeded. This note is not the person's approval: anything that sends, posts, buys, books or deletes still needs their yes where it did before.]`;
}
