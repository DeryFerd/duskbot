import { RefreshCw } from "../icons";
import { t } from "@/lib/i18n";
import { NOTE_ACTION, TranscriptNote } from "./TranscriptNote";

/** A stopped turn, never an error: one quiet word, whoever stopped it. `name` is the row's tool name. */
export function CancelledTurnRow({ onRetry }: { onRetry?: () => void; name?: string }) {
  return (
    <TranscriptNote
      text={t("chat.turnStopped")}
      actions={onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={NOTE_ACTION}
        >
          <RefreshCw size={12} /> {t("chat.retry")}
        </button>
      )}
    />
  );
}
