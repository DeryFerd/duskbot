// After the phone app updated to or past a release that is a multiple of WHATS_NEW_EVERY, What's new opens once as a
// sheet, when the changelog has lines for the phone. The app's own version (1.2.x) is not a release's (0.2.x), so the notes
// are the releases since the last ones this phone showed.
import { useEffect, useState } from "react";
import { PHONE_AREAS, loadReleases, notesForUpdate, updateToTell, updateTold, updatedThisLaunch, type Release } from "@/lib/release-notes";
import { useAiConsent } from "./consent/AiConsent";
import { usePlatform } from "./platform";
import { WhatsNewPage } from "./sheets/UpdatesPage";

const RELEASE_KEY = "dusk-whats-new:phone-release";

export function PhoneUpdatedLine() {
  const platform = usePlatform();
  const consent = useAiConsent();
  const [notes, setNotes] = useState<Release[] | null>(null);
  useEffect(() => {
    const updated = updatedThisLaunch("phone", platform.appVersion);
    let said: string | null = null;
    try { said = localStorage.getItem(RELEASE_KEY); } catch { /* shows the newest only */ }
    if (!updated && !updateToTell("phone", null, null)) return;
    let active = true;
    void loadReleases({ native: platform.native }).then((all) => {
      const newest = all[0]?.version;
      if (!active || !newest) return;
      const due = updateToTell("phone", updated ? newest : null, said);
      if (updated) { try { localStorage.setItem(RELEASE_KEY, newest); } catch { /* the next update starts from the same release */ } }
      if (!due) return;
      const releases = notesForUpdate(all, PHONE_AREAS, due.from, due.to);
      updateTold("phone", due.to);
      if (releases.length) setNotes(releases);
    });
    return () => { active = false; };
  }, [platform.appVersion, platform.native]);
  if (!notes || (consent && (consent.asking || !consent.consent))) return null;
  return <WhatsNewPage notes={notes} updatedTo={platform.appVersion} onClose={() => setNotes(null)} />;
}
