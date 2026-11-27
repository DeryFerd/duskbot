import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { CHROME_RAIL_PATH, FRAME_GRACE_MS, createChromeRail } from "./chrome-rail.mjs";
import { TRAFFIC_LIGHTS } from "./window-chrome.mjs";

const RAIL = "http://127.0.0.1:8799/rail";

/** The app's window: its page (what it is told) and the views laid over it. */
function appWindow() {
  const page = Object.assign(new EventEmitter(), { mainFrame: { id: "page-frame" }, told: [], destroyed: false, focused: 0,
    send(channel, value) { this.told.push([channel, value]); }, focus() { this.focused++; }, isDestroyed() { return this.destroyed; } });
  const children = [];
  const win = Object.assign(new EventEmitter(), { webContents: page, size: [1440, 900], destroyed: false, lights: [],
    getContentSize() { return this.size; }, isDestroyed() { return this.destroyed; }, setWindowButtonPosition(point) { this.lights.push(point); },
    contentView: { addChildView: (view) => children.push(view), removeChildView: (view) => children.splice(children.indexOf(view), 1) } });
  return { win, page, children };
}

function viewMaker() {
  const made = [];
  const createView = (options) => {
    const contents = Object.assign(new EventEmitter(), { mainFrame: { id: "rail-frame" }, loaded: [], sent: [], focused: 0, closed: false, opener: null,
      loadURL(url) { this.loaded.push(url); return Promise.resolve(); }, setWindowOpenHandler(handler) { this.opener = handler; },
      send(channel, ...values) { this.sent.push([channel, ...values]); }, focus() { this.focused++; }, isDestroyed() { return this.closed; }, close() { this.closed = true; } });
    const view = { options, webContents: contents, bounds: null, background: null, setBounds(bounds) { this.bounds = bounds; }, setBackgroundColor(color) { this.background = color; } };
    made.push(view);
    return view;
  };
  return { made, createView };
}

function world({ frame = true } = {}) {
  const { win, page, children } = appWindow();
  const { made, createView } = viewMaker();
  const rail = createChromeRail({ createView, preload: "/app/preload.cjs", args: () => ["--dusk-local-origin=http://127.0.0.1:8799", "--dusk-company-desktop=1"], url: () => RAIL,
    prefs: () => ({ windowFrame: () => frame }) });
  const handlers = new Map();
  rail.install({ handle: (channel, handler) => handlers.set(channel, handler) });
  /** The window's page asks, from its main frame. */
  const ask = (channel, ...values) => handlers.get(channel)({ sender: page, senderFrame: page.mainFrame }, ...values);
  return { rail, win, page, children, made, handlers, ask };
}

test("no rail: attaching the window makes no view, moves nothing and offers no button to hide one", () => {
  const w = world();
  w.rail.attach(w.win);
  w.page.emit("dom-ready");
  w.rail.refresh();
  assert.deepEqual([w.made.length, w.children.length, w.page.told, w.rail.shown()], [0, 0, [], false]);
  assert.deepEqual([...w.handlers.keys()].sort(), ["rail:draws-frame", "rail:expand"], "no rail:offer or rail:hide");
});

test("the accounts sheet holds this app's page over the whole window, and letting go takes it away again", () => {
  const w = world();
  w.rail.attach(w.win);
  w.rail.holdOpen(true);
  const [view] = w.made;
  assert.deepEqual([w.children, w.rail.shown()], [[view], true]);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1440, height: 900 }, "the whole window, never a strip");
  assert.equal(view.background, "#00000000", "transparent but for the sheet");
  assert.deepEqual(view.webContents.loaded, [RAIL]);
  assert.deepEqual(view.options.webPreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: "/app/preload.cjs",
    additionalArguments: ["--dusk-local-origin=http://127.0.0.1:8799", "--dusk-company-desktop=1"] });
  w.win.size = [1000, 700];
  w.win.emit("resize");
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1000, height: 700 }, "it follows the window's size");
  assert.deepEqual(w.page.told, [], "the page under it is told nothing and moves nothing");
  w.rail.holdOpen(false);
  assert.deepEqual([w.children, w.rail.shown()], [[], false]);
  w.rail.holdOpen(true);
  assert.equal(w.made.length, 1, "the same page comes back");
});

test("the sheet takes the keyboard and gives it back to the page; only the sheet's page may ask", () => {
  const w = world();
  w.rail.attach(w.win);
  w.rail.holdOpen(true);
  const [view] = w.made;
  const fromRail = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
  w.handlers.get("rail:expand")(fromRail, true);
  assert.equal(view.webContents.focused, 1);
  w.handlers.get("rail:expand")(fromRail, false);
  assert.equal(w.page.focused, 1);
  for (const event of [{ sender: w.page, senderFrame: w.page.mainFrame }, { sender: view.webContents, senderFrame: { id: "an-iframe" } }, {}]) {
    assert.throws(() => w.handlers.get("rail:expand")(event, true), /only available to the window's sheet page/);
  }
  assert.equal(w.rail.owns(fromRail), true);
  assert.equal(w.rail.owns({ sender: w.page, senderFrame: w.page.mainFrame }), false, "a place's page is never the sheet's");
});

test("the sheet's page stays this app's: no other page, no new window; the window closing closes it", () => {
  const w = world();
  w.rail.attach(w.win);
  w.rail.holdOpen(true);
  const contents = w.made[0].webContents;
  for (const [target, kept] of [[RAIL, true], ["https://evil.example.test/", false], ["http://127.0.0.1:8799/", false]]) {
    let prevented = false;
    contents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, target);
    assert.equal(prevented, !kept, target);
  }
  assert.deepEqual(contents.opener({ url: "https://evil.example.test/" }), { action: "deny" });
  w.win.emit("closed");
  assert.equal(contents.closed, true);
  assert.equal(w.rail.shown(), false);
});

test("the traffic lights sit in the frame's top bar beside a page that draws it, and go back where an older release left room for them", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world();
  w.rail.attach(w.win);
  t.mock.timers.tick(FRAME_GRACE_MS - 1);
  w.ask("rail:draws-frame");
  t.mock.timers.tick(FRAME_GRACE_MS);
  assert.deepEqual([w.rail.framed(), w.win.lights], [true, []], "this app's page draws the frame in time: the window stays as it opened");
  w.page.emit("did-navigate");
  t.mock.timers.tick(FRAME_GRACE_MS - 1);
  assert.equal(w.rail.framed(), true, "still time for the next page");
  t.mock.timers.tick(1);
  assert.deepEqual([w.rail.framed(), w.win.lights], [false, [TRAFFIC_LIGHTS.unframed]], "an older Cloud's page, which never says so: the lights go back to its row");
  w.page.emit("did-navigate");
  w.ask("rail:draws-frame");
  assert.deepEqual([w.rail.framed(), w.win.lights.at(-1)], [true, TRAFFIC_LIGHTS.framed], "the next page draws it: back in the bar at once");
  w.page.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://cloud.example.test/", true);
  t.mock.timers.tick(FRAME_GRACE_MS);
  assert.equal(w.rail.framed(), true, "a load cut short by another leaves the page as it was");
  w.page.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://cloud.example.test/", true);
  t.mock.timers.tick(FRAME_GRACE_MS);
  assert.equal(w.rail.framed(), false, "an error page in its place draws no frame");
  w.rail.holdOpen(true);
  const [view] = w.made;
  for (const event of [{ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { sender: w.page, senderFrame: { id: "an-iframe" } }, {}]) {
    assert.throws(() => w.handlers.get("rail:draws-frame")(event), /only available to the window's page/);
  }
  w.win.emit("closed");
});

test("a page with the frame turned off says it draws none: the traffic lights go back at once, and the window opens that way next time", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world();
  w.rail.attach(w.win);
  w.ask("rail:draws-frame", true);
  w.ask("rail:draws-frame", false);
  assert.deepEqual([w.rail.framed(), w.win.lights], [false, [TRAFFIC_LIGHTS.unframed]], "no grace to wait out: the page said so");
  w.ask("rail:draws-frame", true);
  assert.deepEqual([w.rail.framed(), w.win.lights.at(-1)], [true, TRAFFIC_LIGHTS.framed], "and back in the bar when it is turned on again");
  const off = world({ frame: false });
  off.rail.attach(off.win);
  t.mock.timers.tick(FRAME_GRACE_MS);
  assert.deepEqual([off.rail.framed(), off.win.lights], [false, []], "a window made with the frame off opened its lights where they stay (windowChromeOptions)");
});

test("main's own wiring: the window shows no rail, whatever places it has, and the accounts sheet still opens over it", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = main.indexOf("const chromeRail = createChromeRail("), end = main.indexOf("chromeRail.install(ipcMain);", start);
  assert.ok(start >= 0 && end > start, "main makes the sheet's page");
  assert.doesNotMatch(main.slice(start, end), /wanted|railHidden|changed/, "nothing in main can bring a rail back");
  assert.doesNotMatch(main, /createPlaceInboxWatch|placeInbox/, "no place is polled for an inbox count to light a rail");
  const { made, createView } = viewMaker();
  const handlers = new Map();
  const context = vm.createContext({ createChromeRail, CHROME_RAIL_PATH, WebContentsView: function WebContentsView(options) { return createView(options); },
    path: { join: (...parts) => parts.join("/") }, __dirname: "/app", slog: () => {}, desktopCompanionRendererArguments: () => [],
    app: { isPackaged: true, getVersion: () => "0.1.133" }, desktopRemoteAccess: null, accountApp: () => true, accountGateNeeded: () => false, rendererOrigin: () => "http://127.0.0.1:8799",
    desktopPrefs: { windowFrame: () => true }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } });
  const chromeRail = vm.runInContext(`${main.slice(start, end)}chromeRail.install(ipcMain); chromeRail`, context);
  const { win, page } = appWindow();
  chromeRail.attach(win);
  chromeRail.refresh();
  assert.deepEqual([made.length, chromeRail.shown(), page.told], [0, false, []], "no rail");
  chromeRail.holdOpen(true);
  assert.deepEqual([made.map((view) => view.webContents.loaded), chromeRail.shown()], [[["http://127.0.0.1:8799/rail"]], true], "the accounts sheet still opens in its page");
  assert.equal(made[0].bounds.width, win.getContentSize()[0], "it covers the window, no strip");
  chromeRail.holdOpen(false);
  assert.equal(chromeRail.shown(), false);
});

/** The app's preload in a page of the window, with what the room needs of the page: its document, size and zoom. */
function pageWithPreload(origin = "https://bots.example.test", pathname = "/", answer = () => undefined) {
  const listeners = new Map(), handlers = new Map(), invoked = [];
  const head = { children: [], append(node) { this.children.push(node); node.isConnected = true; } };
  const document = { documentElement: { style: { zoom: "" } }, head, createElement: () => ({ textContent: "", isConnected: false, remove() { head.children.splice(head.children.indexOf(this), 1); this.isConnected = false; } }) };
  const frame = { zoom: 1 }, navigator = { userActivation: { isActive: false } };
  let bridge = null;
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: ["--dusk-local-origin=http://127.0.0.1:8799", "--dusk-company-desktop=1"] },
    location: { origin, pathname }, navigator, TextEncoder, localStorage: { getItem: () => null }, queueMicrotask, document,
    window: { addEventListener: (type, listener) => listeners.set(type, listener) },
    require: () => ({ webUtils: {}, webFrame: { getZoomFactor: () => frame.zoom }, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on: (channel, handler) => handlers.set(channel, handler), removeListener: (channel, handler) => { if (handlers.get(channel) === handler) handlers.delete(channel); },
        send() {}, sendSync: () => null, invoke: (channel, ...values) => { invoked.push([channel, ...values]); return Promise.resolve(answer(channel, ...values)); } } }),
  });
  return { head, frame, root: document.documentElement, bridge, invoked, navigator, resize: () => listeners.get("resize")(),
    hear: (channel, ...values) => handlers.get(channel)?.({}, ...values) };
}

test("the sheet's own page keeps its size at any zoom of this app's page (Chromium shares a host's zoom); no other page is touched", () => {
  const rail = pageWithPreload("http://127.0.0.1:8799", "/rail");
  rail.frame.zoom = 1.25;
  rail.resize();
  assert.equal(rail.root.style.zoom, "0.8", "zoomed in, the sheet's page takes the zoom back out");
  rail.frame.zoom = 1;
  rail.resize();
  assert.equal(rail.root.style.zoom, "");
  for (const [origin, pathname] of [["http://127.0.0.1:8799", "/"], ["https://bots.example.test", "/rail"]]) {
    const page = pageWithPreload(origin, pathname);
    page.frame.zoom = 1.25;
    page.resize();
    assert.equal(page.root.style.zoom, "", `${origin}${pathname} keeps its zoom`);
  }
});

test("every page in the window gets only the frame's bridge to main: an older page's rail calls are answered no rail, and nothing leaves room for one", async () => {
  const remote = pageWithPreload("https://bots.example.test", "/");
  assert.deepEqual(Object.keys(remote.bridge.rail), ["state", "drawsFrame", "setHidden", "onState"]);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  remote.navigator.userActivation.isActive = true;
  assert.deepEqual(plain([await remote.bridge.rail.state(), await remote.bridge.rail.setHidden(true)]), [{ available: false, hidden: false }, { available: false, hidden: false }],
    "an older page's button never shows, and a click asks main nothing");
  const heard = [];
  remote.bridge.rail.onState((state) => heard.push(state))();
  remote.hear("rail:state", { available: true, hidden: false });
  assert.deepEqual(heard, []);
  await remote.bridge.rail.drawsFrame();
  await remote.bridge.rail.drawsFrame(false);
  assert.deepEqual(plain(remote.invoked), [["rail:draws-frame", true], ["rail:draws-frame", false]], "only the frame reaches main");
  remote.hear("rail:beside", 36);
  remote.resize();
  assert.deepEqual(remote.head.children, [], "nothing moves the page over, whatever main might send");
  const local = pageWithPreload("http://127.0.0.1:8799", "/");
  assert.deepEqual(Object.keys(local.bridge.rail), ["state", "drawsFrame", "setHidden", "onState", "expand", "onSkin", "onFramed"]);
});

test("the sheet's page that couldn't load (this app's server was restarting) loads again at the next refresh, so the sheet isn't left blank", () => {
  const w = world();
  w.rail.attach(w.win);
  w.rail.holdOpen(true);
  const contents = w.made[0].webContents, loads = () => contents.loaded.length;
  assert.equal(loads(), 1);
  w.rail.refresh();
  assert.equal(loads(), 1, "loaded or on its way: not loaded again");
  contents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:8799/rail", true);
  assert.equal(loads(), 1, "nothing retries until the server says it is ready");
  w.rail.refresh();
  assert.equal(loads(), 2, "the next refresh loads it");
  w.rail.refresh();
  assert.equal(loads(), 2, "once");
  contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://127.0.0.1:8799/rail", true);
  w.rail.refresh();
  assert.equal(loads(), 2, "a load cut short by another isn't a failure");
  contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://cdn.example.test/", false);
  w.rail.refresh();
  assert.equal(loads(), 2, "nor a frame inside it");
  contents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:8799/rail", true);
  contents.emit("did-finish-load");
  w.rail.refresh();
  assert.equal(loads(), 3, "the error page that replaced it finishing loading isn't the rail's page loading (seen in the real app)");
  contents.emit("did-finish-load");
  w.rail.refresh();
  assert.equal(loads(), 3, "and the load that worked stays");
});
