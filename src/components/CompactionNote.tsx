import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { TranscriptNote } from "./TranscriptNote";

/** Shown only where the person compacted the chat themselves (/compact, Compact now). Automatic summaries (the size
 * threshold, hours away, the warm summary) stay silent: the record is kept for search and the replay, never shown. */
export function compactionShown(message: Pick<Message, "compaction">): boolean {
  return message.compaction?.by === "person";
}

export function CompactionNote({ message }: { message: Message }) {
  if (!compactionShown(message)) return null;
  return <TranscriptNote text={t("chat.compacted.person")} data-compaction-note="person" />;
}
