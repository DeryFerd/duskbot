import { t } from "./i18n";

/** The warm summary's line ("Summarized this conversation while it was idle…"): an automatic compaction, so silent in
 * every mode. Rows written before the server marked them (`autoSummary`) are known by their words. */
export function isAutoSummaryRow(message: { kind: string; autoSummary?: true; tool?: { name?: string } }): boolean {
  if (message.autoSummary) return true;
  return message.kind === "activity" && Boolean(message.tool?.name) && message.tool!.name === t("server.warmSummary.summarized");
}
