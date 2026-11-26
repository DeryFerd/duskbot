import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { TranscriptNote } from "./TranscriptNote";

/** Where a long chat was summarized: one quiet line, so a person can tell when and why the bot works from a summary.
 * The whole chat stays in the transcript either way. */
export function compactionNoteText(compaction: NonNullable<Message["compaction"]>): string {
  if (compaction.by === "person") return t("chat.compacted.person");
  if (compaction.awayHours !== undefined) return t("chat.compacted.away", { hours: Math.max(1, Math.round(compaction.awayHours)) });
  return t("chat.compacted.auto");
}

export function CompactionNote({ message }: { message: Message }) {
  if (!message.compaction) return null;
  return <TranscriptNote text={compactionNoteText(message.compaction)} data-compaction-note={message.compaction.by} />;
}
