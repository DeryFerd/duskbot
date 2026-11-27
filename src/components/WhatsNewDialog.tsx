import { useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { createPortal } from "react-dom";

import updateScene from "../assets/whats-new/update-scene.webp";
import { RELEASES_URL, openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { NOTES_SHOWN_FIRST, changesIn, groupChanges, type Release, type ReleaseKind } from "@/lib/release-notes";
import { MausAvatar } from "./Avatar";
import { ChangeIcon } from "./ui/ChangeIcon";
import { formSheetCls, mdPrimaryCls, mdSecondaryCls, useDialogKeys } from "./ui/GrokDialog";
import { X } from "../icons";
import { ScrimMotion, SheetMotion, useDialogMotion } from "./ui/SheetMotion";

const KIND_LABEL: Record<ReleaseKind, "whatsNew.kind.new" | "whatsNew.kind.better" | "whatsNew.kind.fixed"> = {
  new: "whatsNew.kind.new", better: "whatsNew.kind.better", fixed: "whatsNew.kind.fixed",
};

/** the pixel scene over the notes: dawn over a cloud, with the mascot waking on it */
export function UpdateArt({ updated, className, children }: { updated: boolean; className?: string; children?: React.ReactNode }) {
  return (
    <div data-whats-new-art="" className={cn("relative h-[112px] shrink-0 overflow-hidden", className)}>
      <img src={updateScene} alt="" aria-hidden="true" draggable={false}
        className="pointer-events-none absolute inset-0 size-full select-none object-cover object-[50%_38%] [image-rendering:pixelated]" />
      <span aria-hidden="true" className="absolute left-1/2 top-[26px] flex -translate-x-1/2">
        <MausAvatar color="purple" bodyId="kit" size={36} state="waking" animated={false} trackPointer={false} />
      </span>
      {updated && (
        <span className="absolute left-3 top-3 rounded-full bg-[#fdfdfd]/88 px-2 py-0.5 text-[11px] font-semibold leading-4 text-[#1c1c1c]">
          {t("whatsNew.pill")}
        </span>
      )}
      {children}
    </div>
  );
}

/** "Updated to 0.2.32", then the changes under New, Better and Fixed: the first few, and the rest a press away */
export function UpdateNotes({ releases, label, heading, phone = false }: { releases: readonly Release[]; label: string; heading?: string; phone?: boolean }) {
  const all = useMemo(() => changesIn(releases), [releases]);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? all : all.slice(0, NOTES_SHOWN_FIRST);
  const groups = groupChanges(shown);
  const text = phone ? "text-[15px] leading-[21px]" : "text-[14px] leading-[20px]";
  return (
    <div data-whats-new-notes="">
      <p className={cn("m-0 font-medium text-ink/56", phone ? "text-[13px] leading-[18px]" : "text-[13px] leading-[18px]")}>{label}</p>
      {heading && <h2 id="whats-new-title" className="m-0 mt-0.5 text-[20px] font-semibold leading-[26px] tracking-[-0.01em] text-ink">{heading}</h2>}
      {groups.map((group) => (
        <section key={group.kind ?? "all"} data-change-kind={group.kind ?? "all"} className="mt-4">
          {group.kind && <h3 className={cn("m-0 mb-1 font-medium text-ink/56", phone ? "text-[13px] leading-[18px]" : "text-[12px] leading-4")}>{t(KIND_LABEL[group.kind])}</h3>}
          <ul className="m-0 flex list-none flex-col p-0">
            {group.items.map((item, index) => (
              <li key={`${group.kind}-${index}`} className={cn("flex items-start gap-2.5 py-[5px] text-pretty text-ink", text)}>
                <ChangeIcon icon={item.icon} kind={item.kind} />
                <span className="pt-0.5">{item.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!expanded && all.length > NOTES_SHOWN_FIRST && (
        <button type="button" data-whats-new-all="" onClick={() => setExpanded(true)}
          className={cn("mt-2 -ms-2 cursor-pointer rounded-full border-0 bg-transparent px-2 font-medium text-ink underline-offset-[3px] transition-colors duration-150 ease-[ease] hover:bg-ink/6 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
            phone ? "h-10 text-[15px]" : "h-7 text-[13px]")}>
          {t("whatsNew.seeAll", { count: all.length })}
        </button>
      )}
    </div>
  );
}

/** What's new for this app: shown once after an update, and from Settings > Updates */
export function WhatsNewDialog({ open, releases, version, updated = false, onClose }: { open: boolean; releases: readonly Release[]; version: string; updated?: boolean; onClose: () => void }) {
  return <AnimatePresence>{open && releases.length > 0 && <WhatsNewSheet key="whats-new" releases={releases} version={version} updated={updated} onClose={onClose} />}</AnimatePresence>;
}

function WhatsNewSheet({ releases, version, updated, onClose }: { releases: readonly Release[]; version: string; updated: boolean; onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const close = useDialogKeys(sheet, onClose);
  const played = useDialogMotion();
  return createPortal(
    <div {...played.layer} className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <ScrimMotion {...played.scrim} aria-hidden="true" className="ui-dialog-scrim absolute inset-0" onMouseDown={() => close.current()} />
      <SheetMotion {...played.sheet} ref={sheet} role="dialog" aria-modal="true" aria-labelledby="whats-new-title" tabIndex={-1} data-whats-new=""
        data-whats-new-updated={updated ? "" : undefined}
        className={cn(formSheetCls, "max-h-[min(640px,calc(100dvh-48px))] max-w-[460px] rounded-[16px] shadow-2xl")}>
        <UpdateArt updated={updated}>
          <button type="button" aria-label={t("common.close")} onClick={() => close.current()}
            className="absolute right-2.5 top-2.5 flex size-7 cursor-pointer items-center justify-center rounded-full border-0 bg-[#fdfdfd]/82 text-[#1c1c1c] transition-colors duration-[120ms] ease-[ease] hover:bg-[#fdfdfd] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
            <X size={13} aria-hidden="true" />
          </button>
        </UpdateArt>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-2 pt-4 [scrollbar-width:thin]">
          <UpdateNotes releases={releases} label={updated ? t("updates.updated", { version }) : t("whatsNew.version", { version })}
            heading={updated ? t("whatsNew.heading") : t("whatsNew.title")} />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 px-6 pb-5 pt-3">
          <button type="button" onClick={() => void openExternalLink(RELEASES_URL)} className={mdSecondaryCls}>{t("whatsNew.allReleases")}</button>
          <button type="button" data-autofocus data-whats-new-done="" onClick={() => close.current()} className={mdPrimaryCls}>{t("whatsNew.gotIt")}</button>
        </div>
      </SheetMotion>
    </div>,
    document.body,
  );
}
