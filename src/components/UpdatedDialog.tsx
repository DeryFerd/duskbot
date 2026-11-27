import { useEffect, useState } from "react";

import { appVersion } from "@/lib/app-links";
import { WHATS_NEW_NOTICE, launchNotice, markLaunchNotice } from "@/lib/notices";
import { DESKTOP_AREAS, loadReleases, notesForUpdate, updateTold, updateToTell, updatedThisLaunch, type Release } from "@/lib/release-notes";
import { WhatsNewDialog } from "./WhatsNewDialog";

let shownThisLaunch = false;
export function resetUpdatedDialogForTests() { shownThisLaunch = false; }

/**
 * After this app updated itself, What's new opens once for that version, over the app. With no notes for it, nothing
 * shows. A launch that already showed another popup leaves it for the next launch.
 */
export function UpdatedDialog({ updated, seen }: { updated: string | null; seen: () => void }) {
  const before = updatedThisLaunch("desktop", window.duskDesktop?.app?.version ?? appVersion());
  const [notes, setNotes] = useState<{ version: string; releases: Release[] } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (updated) seen();
    const due = updateToTell("desktop", updated, before);
    if (!due || shownThisLaunch) return;
    let active = true;
    void loadReleases().then((all) => {
      if (!active || shownThisLaunch || !all.length) return;
      const releases = notesForUpdate(all, DESKTOP_AREAS, due.from, due.to);
      if (!releases.length) return updateTold("desktop", due.to);
      const claimed = launchNotice();
      if (claimed && claimed !== WHATS_NEW_NOTICE) return;
      markLaunchNotice(WHATS_NEW_NOTICE);
      updateTold("desktop", due.to);
      shownThisLaunch = true;
      setNotes({ version: due.to, releases });
      setOpen(true);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updated]);
  if (!notes) return null;
  return <WhatsNewDialog open={open} releases={notes.releases} version={notes.version} updated onClose={() => setOpen(false)} />;
}
