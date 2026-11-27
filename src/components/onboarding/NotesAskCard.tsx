import { useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { botButton } from "@/lib/bot-button";
import { cn } from "@/lib/cn";
import type { MausColor } from "@/lib/mascot";
import { t } from "@/lib/i18n";
import { DEFAULT_BOT_NAME } from "@/lib/default-bot";
import { MausAvatar } from "../Avatar";
import { usePrefersReducedMotion } from "../mascot-clock";
import { useDialogKeys } from "../ui/GrokDialog";
import { SIMPLE_BUTTONS, SIMPLE_CARD } from "../SettingsPrimitives";
import "../../styles/settings.css";
import { BRAND_LILAC, useCascade } from "./FunnelSteps";
import { markNotesAskShown, shareSessionNotes } from "./notes-ask";

/** the mascot's colour, which the yes button wears too */
const MASCOT: MausColor = "purple";
const YES = botButton(MASCOT, "ui-button", "");

/** The one ask about session summaries, over the app. They stay off unless "Share summaries" is pressed. */
export function NotesAskCard({ onDone }: { onDone: (yes: boolean) => void }) {
  const reduced = usePrefersReducedMotion();
  const rise = useCascade();
  const sheet = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const exampleId = useId();
  const bodyId = useId();
  const [example, setExample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(markNotesAskShown, []);

  const share = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await shareSessionNotes();
      onDone(true);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  const close = () => { if (!busy) onDone(false); };
  useDialogKeys(sheet, close);

  return (
    <div data-notes-ask="" data-settings-sheet data-settings-look="simple" className="settings-scrim"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div aria-hidden="true" className="settings-backdrop pointer-events-none" />
      <div ref={sheet} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}
        className="settings-dialog" style={{ width: "min(420px, 100vw - 32px)" }}>
        <section className="settings-panel min-h-0">
          <div className="settings-pane-header" style={{ flexWrap: "nowrap", justifyContent: "flex-start", gap: 8 }}>
            <motion.div aria-hidden="true" className="flex shrink-0 items-end pl-2.5" {...rise(0)}>
              <MausAvatar color={MASCOT} gradient={BRAND_LILAC} size={28} state="excited" animated={!reduced} label={DEFAULT_BOT_NAME} />
            </motion.div>
            <motion.h2 id={titleId} className="settings-pane-title !pl-0" {...rise(1)}>
              {t("notesAsk.title")}
            </motion.h2>
          </div>
          <div className="settings-scroll">
            <div className={cn("settings-pane", SIMPLE_BUTTONS)} style={{ gap: 14, paddingBottom: 20 }}>
              <motion.div className="flex flex-col gap-1.5" {...rise(2)}>
                <p id={bodyId} className="m-0 px-2.5 text-pretty text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{t("notesAsk.body")}</p>
                <p className="m-0 px-2.5 text-pretty text-[12px] leading-4 text-ink-tertiary">{t("notesAsk.facts")}</p>
                <button type="button" data-notes-example="" aria-expanded={example} aria-controls={exampleId} onClick={() => setExample((open) => !open)}
                  className="inline-flex min-h-8 items-center self-start rounded-full px-2.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary transition-[color] duration-[120ms] ease-[ease] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                  {t(example ? "notesAsk.exampleHide" : "notesAsk.example")}
                </button>
                <div id={exampleId} className="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none"
                  style={{ gridTemplateRows: example ? "1fr" : "0fr", opacity: example ? 1 : 0 }} aria-hidden={!example} inert={!example || undefined}>
                  <div className="min-h-0 overflow-hidden">
                    <div className={cn(SIMPLE_CARD, "px-3 py-2.5 text-start")}>
                      <p className="m-0 text-[13px] leading-[18px] tracking-[0.015em] text-ink">{t("notesAsk.exampleHead")}</p>
                      <p className="m-0 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{t("notesAsk.exampleNote")}</p>
                    </div>
                  </div>
                </div>
              </motion.div>
              {failed && (
                <div role="alert" className="px-2.5 text-[13px] leading-[18px]">
                  <p className="m-0 text-danger">{t("notesAsk.errorTitle")}</p>
                  <p className="m-0 text-ink-secondary">{t("settings.dataSharing.checkConnection")}</p>
                </div>
              )}
              <motion.div className="flex flex-wrap justify-end gap-2 px-2.5" {...rise(3)}>
                <button type="button" data-notes-no="" disabled={busy} onClick={close} className="ui-button">
                  {t("notesAsk.no")}
                </button>
                <button type="button" data-notes-yes="" disabled={busy} aria-busy={busy || undefined} onClick={() => void share()}
                  className={YES.className} style={YES.style}>
                  {t("notesAsk.yes")}
                </button>
              </motion.div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
