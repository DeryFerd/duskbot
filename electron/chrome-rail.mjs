// This app's small page (`/rail`) in a view of its own over the window, up only while it holds the accounts sheet: it
// covers the window, transparent but for the sheet, whichever place's page the window shows. The window has no rail of
// places; no place's page ever reads the list of places or accounts this page is given.
//
// The page in the window draws the window's frame (its top bar, with the traffic lights in it) when it says so, as each
// document does once it is on screen. One that doesn't, a Cloud or a server of the person's own on an older release,
// gets the window as that release made it: the traffic lights back where it left room for them. A new document has a few
// seconds to say so before the window changes back.

import { TRAFFIC_LIGHTS } from "./window-chrome.mjs";

export const CHROME_RAIL_PATH = "/rail";
/** How long a framed window stays framed for the page's next document. */
export const FRAME_GRACE_MS = 5_000;

/** Chromium's net::ERR_ABORTED: a load replaced by another, not a page that failed. */
const ABORTED = -3;

/**
 * @param {{
 *   createView: (options: object) => any,
 *   preload: string,
 *   args: () => string[],
 *   url: () => string,
 *   prefs?: () => { windowFrame?(): boolean } | null,
 *   log?: (line: string) => void,
 * }} deps `url()`: the sheet's page on this app's own server; `args()`: the preload's arguments, as the window's own page
 * gets them; `prefs()`: whether this desktop made the window with its frame.
 */
export function createChromeRail({ createView, preload, args, url, prefs = () => null, log = () => {} }) {
  let view = null, win = null, shown = false, held = false;
  // The sheet's page didn't load (this app's server was restarting): it loads again at the next refresh.
  let unloaded = false;
  // Whether the page in the window draws the frame; the window opens as if it does (windowChromeOptions).
  let framed = true, frameGrace = null;
  const alive = () => Boolean(win && !win.isDestroyed());
  const layout = () => {
    if (!view || !shown || !alive()) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  const page = () => (alive() && !win.webContents.isDestroyed() ? win.webContents : null);
  /** The traffic lights where the page makes room for them (macOS only). */
  const frameDrawn = (next) => {
    clearTimeout(frameGrace); frameGrace = null;
    if (next === framed) return;
    framed = next;
    if (alive()) win.setWindowButtonPosition?.(framed ? TRAFFIC_LIGHTS.framed : TRAFFIC_LIGHTS.unframed);
  };
  /** A framed window stays framed while the next document has its few seconds to say it draws the frame too. */
  const awaitFrame = () => {
    clearTimeout(frameGrace);
    frameGrace = framed ? setTimeout(() => frameDrawn(false), FRAME_GRACE_MS) : null;
  };
  /** The window's own page, in its main frame (never a frame inside it). */
  const pageAsks = (event) => Boolean(page() && event?.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  const load = (contents) => { void contents.loadURL(url()).catch((error) => log(`chrome rail: ${error?.message ?? error}`)); };
  const ensureView = () => {
    if (view) return view;
    view = createView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload, additionalArguments: args() } });
    view.setBackgroundColor?.("#00000000");
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const stay = (event, target) => { if (target !== url()) event.preventDefault(); };
    contents.on("will-navigate", stay);
    contents.on("will-redirect", stay);
    contents.on("render-process-gone", () => { log("chrome rail: its page went away; loading it again"); void contents.loadURL(url()).catch(() => {}); });
    // Only a load's failing says so: the error page that replaces it finishes loading too.
    contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== ABORTED) unloaded = true; });
    load(contents);
    return view;
  };
  const rail = {
    /** The window the sheet goes over: its size sizes the sheet, and each of its documents says whether it draws the frame. */
    attach(next) {
      win = next;
      shown = false; held = false;
      framed = prefs()?.windowFrame?.() !== false;
      awaitFrame();
      win.on("resize", layout);
      const contents = win.webContents;
      contents.on("did-navigate", awaitFrame);
      contents.on("render-process-gone", awaitFrame);
      // Electron 43 reports an error page that replaced the document here, not as did-navigate.
      contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== ABORTED) awaitFrame(); });
      win.once("closed", () => {
        if (view && !view.webContents.isDestroyed()) view.webContents.close?.({ waitForBeforeUnload: false });
        clearTimeout(frameGrace); frameGrace = null;
        view = null; win = null; shown = false; held = false;
      });
    },
    /** Up while the sheet is held open, over the whole window; gone otherwise. */
    refresh() {
      const on = alive() && held;
      if (view && unloaded && on) { unloaded = false; load(view.webContents); }
      if (on === shown) { layout(); return; }
      shown = on;
      if (on) {
        win.contentView.addChildView(ensureView());
        layout();
      } else if (view) win.contentView.removeChildView(view);
    },
    /** The accounts sheet, shown on this page over the page in the window. */
    holdOpen(on) {
      held = on === true;
      rail.refresh();
    },
    /** The sheet is open: the keyboard goes with it, and back to the page once it closes. */
    expand(on) {
      if (on === true && shown) view?.webContents.focus();
      else page()?.focus?.();
    },
    /** This page asks (never a place's page). */
    owns: (event) => Boolean(view && event?.sender === view.webContents && event.senderFrame === view.webContents.mainFrame),
    shown: () => shown,
    framed: () => framed,
    install(ipcMain) {
      ipcMain.handle("rail:expand", (event, on) => {
        if (!rail.owns(event)) throw new Error("rail:expand is only available to the window's sheet page");
        rail.expand(on === true);
      });
      ipcMain.handle("rail:draws-frame", (event, drawn) => {
        if (!pageAsks(event)) throw new Error("rail:draws-frame is only available to the window's page");
        frameDrawn(drawn !== false);
      });
    },
    /** Tells this page something (the accounts changed, the skin of the page in the window). */
    send(channel, ...values) {
      if (view && !view.webContents.isDestroyed()) view.webContents.send(channel, ...values);
    },
  };
  return rail;
}
