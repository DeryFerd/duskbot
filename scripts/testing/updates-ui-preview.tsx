// Settings > Updates as the desktop app shows it, against a fixture server, with main's updater and the update answers
// faked (scripts/testing/updates-ui-fakes.ts). ?app=current|downloading|ready|remote|remote-ready|place|place-ready (remote:
// paired as a client of another server; place: a server of the person's own open in the window), ?updated=<version> (the first launch
// after an update: the sidebar spot's line), ?skin=. Served only by scripts/verify-updates-ui.ts.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { SettingsModal } from "../../src/components/SettingsModal";
import { SidebarSpot } from "../../src/components/SidebarSpot";
import { setEmailGateDone } from "../../src/lib/analytics";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { setLocale } from "../../src/lib/i18n";
import { openSettings } from "../../src/lib/open-settings";
import { applySkin, type SkinId } from "../../src/lib/skins";
import { StoreProvider, useStore } from "../../src/state/store";
import { installUpdateFakes } from "./updates-ui-fakes";
import "../../src/font-faces.css";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";
import "../../src/styles/desktop-motion.css";

const params = new URLSearchParams(location.search);
setLocale("en");
setEmailGateDone("skipped");
applySkin((params.get("skin") ?? "grok") as SkinId);
installUpdateFakes(params);
const app = params.get("app") ?? "current";
const updated = params.get("updated");
if (updated) localStorage.setItem("dusk-whats-new:desktop", params.get("from") ?? "0.2.30");
const remote = app.startsWith("remote"), place = app.startsWith("place");
const state = app.endsWith("ready") ? { ready: "0.2.32", mode: "self" }
  : app === "downloading" ? { ready: null, available: "0.2.32", progress: 0.42, mode: "self" }
  : { ready: null, mode: "self", ...(updated ? { updated } : {}) };
window.duskDesktop = {
  platform: "darwin",
  app: { version: "0.2.31", ownPage: !place },
  ...(remote ? { remoteClient: { active: true } } : {}),
  getCapabilities: async () => initialDesktopCapabilities(),
  appUpdate: {
    state: async () => state,
    onState: () => () => {},
    download: async () => { await new Promise((done) => setTimeout(done, 900)); return null; },
    restart: async () => false,
    seen: async () => {},
  },
} as unknown as typeof window.duskDesktop;

function Preview() {
  const { dispatch } = useStore();
  useEffect(() => { if (!updated) dispatch(openSettings("updates")); }, [dispatch]);
  return <main data-preview-ready="" className="min-h-[100dvh] bg-app">
    {updated && <div className="w-[260px] p-3"><SidebarSpot /></div>}
    <SettingsModal />
  </main>;
}
createRoot(document.getElementById("root")!).render(<StoreProvider><DesktopCapabilitiesProvider><Preview /></DesktopCapabilitiesProvider></StoreProvider>);
