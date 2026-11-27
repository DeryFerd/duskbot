import { useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { botButton } from "@/lib/bot-button";
import type { MausColor } from "@/lib/mascot";
import { t } from "@/lib/i18n";
import { DEFAULT_BOT_NAME } from "@/lib/default-bot";
import { MausAvatar } from "../Avatar";
import { usePrefersReducedMotion } from "../mascot-clock";
import { useDialogKeys } from "../ui/GrokDialog";
import { BRAND_LILAC, useCascade } from "./FunnelSteps";
import { markNotesAskShown, shareSessionNotes } from "./notes-ask";

/** the mascot's colour, which the yes button wears too */
const MASCOT: MausColor = "purple";
const YES = botButton(MASCOT, "ui-button min-h-9 gap-1.5 rounded-full px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus mt-3 w-full justify-center disabled:opacity-60", "");

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
    <div data-notes-ask="" className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={sheet} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}
        className="ui-modal relative my-auto flex w-[360px] max-w-full flex-col items-center border-0 px-5 pb-3 pt-5 text-center text-ink outline-none">
        <motion.div aria-hidden="true" className="flex h-11 items-end justify-center" {...rise(0)}>
          <MausAvatar color={MASCOT} gradient={BRAND_LILAC} size={44} state="excited" animated={!reduced} label={DEFAULT_BOT_NAME} />
        </motion.div>
        <motion.h2 id={titleId} className="mt-3 text-balance text-[19px] font-semibold leading-6 tracking-[-0.012em]" {...rise(1)}>
          {t("notesAsk.title")}
        </motion.h2>
        <motion.div className="w-full" {...rise(2)}>
          <p id={bodyId} className="m-0 mt-1.5 text-pretty text-[14px] leading-5 text-ink-secondary">{t("notesAsk.body")}</p>
          <p className="m-0 mt-2 text-pretty text-[13px] leading-[18px] text-ink-tertiary">{t("notesAsk.facts")}</p>
          <button type="button" data-notes-example="" aria-expanded={example} aria-controls={exampleId} onClick={() => setExample((open) => !open)}
            className="mt-1 inline-flex min-h-8 items-center rounded-full px-2 text-[13px] text-ink-secondary underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
            {t(example ? "notesAsk.exampleHide" : "notesAsk.example")}
          </button>
          <div id={exampleId} className="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none"
            style={{ gridTemplateRows: example ? "1fr" : "0fr", opacity: example ? 1 : 0 }} aria-hidden={!example} inert={!example || undefined}>
            <div className="min-h-0 overflow-hidden">
              <div className="mt-2 rounded-[12px] bg-ink/[0.045] px-3.5 py-3 text-start">
                <p className="m-0 text-[13px] font-medium leading-[17px] text-ink">{t("notesAsk.exampleHead")}</p>
                <p className="m-0 text-[13px] leading-[17px] text-ink-secondary">{t("notesAsk.exampleNote")}</p>
              </div>
            </div>
          </div>
        </motion.div>
        {failed && (
          <div role="alert" className="mt-3 w-full text-[13px] leading-[18px]">
            <p className="m-0 text-danger">{t("notesAsk.errorTitle")}</p>
            <p className="m-0 text-ink-secondary">{t("settings.dataSharing.checkConnection")}</p>
          </div>
        )}
        <motion.div className="flex w-full flex-col items-center" {...rise(3)}>
          <button type="button" data-notes-yes="" disabled={busy} aria-busy={busy || undefined} onClick={() => void share()}
            className={YES.className} style={YES.style}>
            {t("notesAsk.yes")}
          </button>
          <button type="button" data-notes-no="" disabled={busy} onClick={close}
            className="mt-1 min-h-9 rounded-full px-3 text-[13px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60">
            {t("notesAsk.no")}
          </button>
        </motion.div>
      </div>
    </div>
  );
}
