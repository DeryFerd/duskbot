// The one quiet line after this app updated itself: "Updated to 0.2.32" with What's new, once, and only when the changelog
// has notes for it; with none it goes by unsaid, as before.
import { useEffect, useState } from "react";

import { appVersion } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { DESKTOP_AREAS, loadReleases, notesForUpdate, updatedThisLaunch, type Release } from "@/lib/release-notes";
import { Toast } from "./ui/Toast";
import { WhatsNewDialog } from "./WhatsNewDialog";

export function UpdatedLine({ updated, seen }: { updated: string | null; seen: () => void }) {
  // the version this app ran before, read once a launch (and this one remembered) before main says it updated
  const before = updatedThisLaunch("desktop", window.duskDesktop?.app?.version ?? appVersion());
  const [notes, setNotes] = useState<{ version: string; releases: Release[] } | null>(null);
  const [line, setLine] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!updated) return;
    seen();
    let active = true;
    void loadReleases().then((all) => {
      if (!active) return;
      const from = before;
      const releases = from ? notesForUpdate(all, DESKTOP_AREAS, from, updated) : notesForUpdate(all, DESKTOP_AREAS, null, updated).filter((release) => release.version === updated);
      if (!releases.length) return;
      setNotes({ version: updated, releases });
      setLine(true);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updated]);
  if (!notes) return null;
  return <>
    {line && <Toast data-notice-toast="" text={t("updates.updated", { version: notes.version })} onDone={() => setLine(false)}
      action={{ label: t("whatsNew.title"), onClick: () => { setLine(false); setOpen(true); } }} />}
    <WhatsNewDialog open={open} releases={notes.releases} current={notes.version} onClose={() => setOpen(false)} />
  </>;
}
