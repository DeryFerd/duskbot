// My Cloud asleep, then waking, then awake, as the edge and the Admin really answer (apps/cloud-service/edge/worker.js,
// apps/dashboard/server/billing/admin-routes.ts): the window says it is waking the whole time, never "Can't reach", and opens
// by itself within seconds of the home answering. Seen 2026-11-26 on a paid cloud: about 2.5 min of "Can't reach my cloud".
import assert from "node:assert/strict";
import test from "node:test";

import { createCloudPowerGate } from "./cloud-power.mjs";
import { createHomeWindow } from "./home-window.mjs";
import { CLOUD, connected, done, json, LOCAL } from "./fixtures/home-window-world.mjs";

/** a sleeping managed cloud: asleep until a wake, waking for `bootMs`, then awake; `down` is a real outage */
function sleepingWorld({ bootMs = 150_000, phase = "asleep", signedIn = true, holdPaint = null } = {}) {
  const w = {
    clock: 1_000_000, phase, wokeAt: null, bootMs, signedIn, down: false, sessions: true,
    went: [], screens: [], wakes: 0, pairs: 0, timers: [], intervals: [], url: `${LOCAL}/`, published: [],
  };
  const now = () => w.clock;
  const tickPhase = () => { if (w.phase === "waking" && w.bootMs !== Infinity && w.clock - w.wokeAt >= w.bootMs) { w.phase = "awake"; w.since = w.clock; } };
  w.since = 1;
  const powerWord = () => { tickPhase(); return { state: w.phase === "awake" ? "awake" : w.phase, since: w.since, sleeps: true }; };
  const timers = {
    set: (work, ms) => { const timer = { work, at: w.clock + ms }; w.timers.push(timer); return timer; },
    clear: (timer) => { w.timers = w.timers.filter((entry) => entry !== timer); },
    every: (work, ms) => { const timer = { work, ms }; w.intervals.push(timer); return timer; },
  };
  const gate = createCloudPowerGate({ power: powerWord, now, setTimer: (work, ms) => timers.set(work, ms), clearTimer: (timer) => timers.clear(timer) });
  const account = {
    state: () => ({ ...connected(), machine: { status: "ready", origin: CLOUD, power: powerWord() } }),
    power: powerWord,
    powerOf: (origin) => (origin === CLOUD ? powerWord() : null),
    async wakeHome(intent) {
      if (!["type", "click", "send"].includes(intent)) return w.phase === "awake" ? null : "asleep";
      w.wakes++;
      if (w.phase === "asleep") { w.phase = "waking"; w.wokeAt = w.clock; }
      tickPhase();
      return w.phase === "awake" ? "awake" : "waking";
    },
    setWaking: () => {},
    async pairHome() {
      w.pairs++;
      tickPhase();
      // the Admin pairs only a running cloud (admin-routes.ts "not_running")
      if (w.phase !== "awake") throw Object.assign(new Error("Cloud request failed."), { status: 409 });
      return { origin: CLOUD, code: "AAAA-BBBB-CCCC", expiresAt: w.clock + 60_000 };
    },
    signInAgain: async () => {}, begin: async () => {},
  };
  const contents = { id: 7, mainFrame: { get url() { return w.url; } }, getURL: () => w.url, reload: () => {} };
  w.window = { isDestroyed: () => false, webContents: contents };
  w.contents = contents;
  const edgeAsleep = () => new Response("This dusk bot is asleep. It wakes when someone uses it.", { status: 503, headers: { "retry-after": "5", "x-dusk-cloud-power": "asleep" } });
  w.home = createHomeWindow({
    journal: () => done(), frozen: async () => null, account: () => account,
    window: () => w.window,
    ensureWindow: () => {}, localOrigin: () => LOCAL,
    cookieFetch: async (url) => {
      tickPhase();
      if (w.down) throw new TypeError("fetch failed");
      // a wake that never comes up: the edge keeps saying the home isn't awake
      if (w.phase === "stuck") return edgeAsleep();
      const route = String(url).replace(CLOUD, "");
      // the edge: a home that isn't awake answers every read 503 "asleep" at once (worker.js waking())
      if (w.phase !== "awake") return edgeAsleep();
      if (route === "/api/health") return new Response("", { status: 200 });
      if (route === "/api/auth/session") return w.signedIn ? json({ kind: "session" }) : json({ error: "sign in" }, 401);
      if (route === "/api/auth/pair") { w.signedIn = true; return json({ kind: "session" }); }
      if (route === "/.well-known/duskbot/environment") return json({ version: "0.2.31" });
      return json({}, 404);
    },
    power: gate,
    go: async (url, origin) => { w.went.push([url, origin]); w.url = url; },
    showLocal: () => {},
    publish: (view) => w.published.push(view),
    now, timers, ...(holdPaint ? { holdPaint: (load) => holdPaint(load, w) } : {}),
  });
  /** what the person sees, each second: the screen the window shows */
  w.seen = () => {
    if (w.url.startsWith(CLOUD)) return "cloud";
    const view = w.home.view();
    return view.screen === "asleep" && view.waking ? "waking" : view.screen;
  };
  w.flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
  w.later = async (ms) => {
    const end = w.clock + ms;
    while (w.clock < end) {
      const next = Math.min(end, ...w.timers.map((timer) => timer.at));
      w.clock = Math.max(w.clock, next);
      const due = w.timers.filter((timer) => timer.at <= w.clock);
      w.timers = w.timers.filter((timer) => timer.at > w.clock);
      for (const timer of due) timer.work();
      await w.flush();
    }
  };
  /** run for `ms`, noting the screen each second; the asleep screen wakes My Cloud on mount, as CloudAsleepHome does */
  w.watch = async (ms) => {
    const seen = [];
    for (let at = 0; at < ms; at += 1_000) {
      const screen = w.seen();
      if (screen === "asleep") { await w.home.wake("click"); await w.flush(); }
      seen.push(w.seen());
      await w.later(1_000);
    }
    return seen;
  };
  return w;
}

test("a sleeping My Cloud woken on open shows waking, never Can't reach, and opens by itself within seconds of answering", async () => {
  const w = sleepingWorld();
  await w.home.show();
  await w.flush();
  const seen = await w.watch(200_000);
  assert.ok(!seen.includes("offline"), `never the offline screen while it wakes: ${[...new Set(seen)].join(", ")}`);
  const opened = seen.indexOf("cloud");
  assert.ok(opened >= 0, "it opens by itself");
  assert.ok(opened * 1_000 <= w.bootMs + 6_000, `within seconds of answering (opened at ${opened} s, awake at ${w.bootMs / 1000} s)`);
  assert.ok(w.wakes >= 1 && w.wakes <= 2, `woken once, not on every look (${w.wakes})`);
});

test("the Admin already waking My Cloud (another device, the edge) shows waking at launch, and opens when it answers", async () => {
  const w = sleepingWorld({ phase: "waking", bootMs: 40_000 });
  w.wokeAt = w.clock - 5_000;
  await w.home.show();
  await w.flush();
  const seen = await w.watch(60_000);
  assert.ok(!seen.includes("offline") && !seen.includes("asleep"), `waking, never asleep or can't reach: ${[...new Set(seen)].join(", ")}`);
  assert.equal(w.wakes, 0, "nothing more to ask: it is already waking");
  assert.ok(seen.indexOf("cloud") * 1_000 <= 35_000 + 3_000, `opens within seconds of answering (${seen.indexOf("cloud")} s)`);
});

test("a message sent while My Cloud wakes is held, and My Cloud's page gets it once, after it opens", async () => {
  const w = sleepingWorld({ bootMs: 20_000 });
  await w.home.show();
  await w.flush();
  assert.equal(w.home.view().screen, "asleep");
  await w.home.wake("send", { botId: "b1", threadId: "t1", text: "are you there?", sendId: "send-0001" });
  await w.flush();
  assert.deepEqual(w.home.view(), { screen: "asleep", waking: true, held: "are you there?" }, "the waking screen keeps the message, marked as sending in a moment");
  await w.later(25_000);
  assert.equal(w.seen(), "cloud", "open once it answered");
  const event = { sender: w.contents, senderFrame: w.contents.mainFrame };
  assert.deepEqual(w.home.takeHeld(event), { botId: "b1", threadId: "t1", text: "are you there?", sendId: "send-0001" });
  assert.equal(w.home.takeHeld(event), null, "sent once");
});

test("a wake that never comes up is a real outage after 5 min: Can't reach, and Try again recovers at once when it is back", async () => {
  const w = sleepingWorld({ bootMs: Infinity });
  await w.home.show();
  await w.flush();
  await w.home.wake("type");
  await w.flush();
  const seen = await w.watch(4 * 60_000);
  assert.ok(!seen.includes("offline"), "4 min in: still waking");
  assert.equal(w.home.view().slow, true, "past a minute it says it's taking longer than usual");
  await w.later(70_000);
  assert.equal(w.home.view().screen, "offline", "5 min with no answer: the offline screen");
  w.phase = "awake"; w.since = w.clock;
  await w.home.retry();
  await w.flush();
  assert.equal(w.seen(), "cloud", "Try again opens it at once");
});

test("My Cloud down for real shows Can't reach, and comes back by itself within seconds once it answers", async () => {
  const w = sleepingWorld({ phase: "awake" });
  w.down = true;
  await w.home.show();
  await w.later(30_000);
  assert.equal(w.home.view().screen, "offline", "a real outage is still said plainly");
  await w.later(5 * 60_000);
  assert.equal(w.home.view().screen, "offline");
  w.down = false;
  const back = w.clock;
  for (let i = 0; i < 30 && w.seen() !== "cloud"; i++) await w.later(1_000);
  assert.equal(w.seen(), "cloud");
  assert.ok(w.clock - back <= 10_000, `back by itself within 10 s (${(w.clock - back) / 1000} s)`);
});

test("My Cloud's page failing while it falls asleep under it shows its asleep screen, never Can't reach", async () => {
  const w = sleepingWorld({ phase: "awake" });
  await w.home.show();
  await w.flush();
  assert.equal(w.seen(), "cloud");
  w.phase = "asleep"; w.since = w.clock;
  assert.equal(w.home.failed(`${CLOUD}/`), true);
  await w.flush();
  assert.equal(w.home.view().screen, "asleep");
});

test("a woken My Cloud whose page loads but takes longer than the picture's hold to draw stays on its page, never back to Can't reach", async () => {
  // what kept the 2026-11-26 window on Can't reach after the cloud answered: each try loaded the page, the picture over it
  // came down after 20 s with nothing drawn yet, and the window went back to the offline screen; only a restart opened it
  const w = sleepingWorld({ bootMs: 5_000, holdPaint: async (load) => { await load(); return false; } });
  await w.home.show();
  await w.flush();
  await w.home.wake("click");
  const seen = await w.watch(60_000);
  assert.ok(!seen.includes("offline"), `never back to the offline screen: ${[...new Set(seen)].join(", ")}`);
  assert.equal(w.seen(), "cloud");
  assert.equal(w.went.filter(([, origin]) => origin === CLOUD).length, 1, "loaded once, not again and again");
});
