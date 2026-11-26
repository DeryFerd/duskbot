import type { ReactNode } from "react";
import { ErrorDetailsCopy } from "./ErrorDetailsCopy";
import { EventLine } from "./EventLine";
import { Icon } from "./Icon";

/** A small pill on a quiet line in the chat. */
export const NOTE_ACTION = "inline-flex items-center gap-1 rounded-full border border-transparent px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";

/** The chat's own note as grok draws its system events: the centered event line, its words wrapping balanced under
 * one another and its pills beside them, never a box. A warning carries one small glyph so its tone is never colour alone. */
export function TranscriptNote({ text, warning = false, details, actions, ...rest }: {
  text: ReactNode;
  warning?: boolean;
  /** the technical words behind a plain line: reported and copyable for support, never shown */
  details?: string | null;
  actions?: ReactNode;
} & { [data: `data-${string}`]: string | undefined }) {
  return (
    <EventLine role="status" data-transcript-note="" {...rest} className="flex-wrap gap-x-2 gap-y-1">
      <span dir="auto" className="min-w-0 max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] text-center text-balance break-words">
        {warning && <Icon name="exclamation-circle" variant="filled" size={14} className="me-1 inline-block shrink-0 align-[-3px] text-warning" />}
        {text}
      </span>
      {actions}
      {details && <span className="flex basis-full justify-center"><ErrorDetailsCopy details={details} /></span>}
    </EventLine>
  );
}
