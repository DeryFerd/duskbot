// My Cloud whose machine the provider paused (InstaBox, 2026-11-27) while the Admin still reads it as awake: the address answers
// with the provider's own page. The window never shows it and never says Can't reach while it resumes: it asks the Admin to
// resume (the wake says the page was met), shows the waking screen, and opens by itself once the home answers.
import assert from "node:assert/strict";
import test from "node:test";

import { createCloudPowerGate, providerPausePage } from "./cloud-power.mjs";
import { createHomeWindow } from "./home-window.mjs";
import { CLOUD, connected, done, json, LOCAL } from "./fixtures/home-window-world.mjs";

const PAGE = "Sandbox offline: it is paused, and only a sandbox that paused itself for being idle wakes on a visit. Its owner can resume it: instabox resume sbx_1";

/** `resumeMs`: how long the Admin's resume takes; Infinity is a provider that keeps refusing */
function pausedWorld({ resumeMs = 8_000 } = {}) {
  const w = { clock: 1_000_000, paused: true, resumeAt: null, wakes: [], went: [], timers: [], intervals: [], url: `${LOCAL}/`, shown: [] };
  const now = () => w.clock;
  const timers = {
    set: (work, ms) => { const timer = { work, at: w.clock + ms }; w.timers.push(timer); return timer; },
    clear: (timer) => { w.timers = w.timers.filter((entry) => entry !== timer); },
    every: (work, ms) => { const timer = { work, ms }; w.intervals.push(timer); return timer; },
  };
  const tick = () => { if (w.paused && w.resumeAt !== null && w.clock >= w.resumeAt) w.paused = false; };
  // the Admin's word is stale: awake, until a wake that names the page moves it
  const powerWord = () => ({ state: w.resumeAt !== null && w.paused ? "waking" : "awake", since: 1, sleeps: true });
  const account = {
    state: () => ({ ...connected(), machine: { status: "ready", origin: CLOUD, power: powerWord() } }),
    power: powerWord,
    powerOf: (origin) => (origin === CLOUD ? powerWord() : null),
    async wakeHome(intent, options = {}) {
      w.wakes.push({ intent, paused: options.paused === true });
      // an Admin asked without the page cannot know: it reads the cloud as awake and does nothing
      if (options.paused === true && w.resumeAt === null && resumeMs !== Infinity) w.resumeAt = w.clock + resumeMs;
      return "waking";
    },
    setWaking: () => {},
    async pairHome() { return { origin: CLOUD, code: "AAAA-BBBB-CCCC", expiresAt: w.clock + 60_000 }; },
    signInAgain: async () => {}, begin: async () => {},
  };
  const gate = createCloudPowerGate({ power: powerWord, now, setTimer: (work, ms) => timers.set(work, ms), clearTimer: (timer) => timers.clear(timer) });
  const contents = { id: 7, mainFrame: { get url() { return w.url; } }, getURL: () => w.url, reload: () => {} };
  w.window = { isDestroyed: () => false, webContents: contents };
  w.home = createHomeWindow({
    journal: () => done(), frozen: async () => null, account: () => account, window: () => w.window,
    ensureWindow: () => {}, localOrigin: () => LOCAL,
    cookieFetch: async (url) => {
      tick();
      const route = String(url).replace(CLOUD, "");
      // the provider's page answers every path while the machine is paused
      if (w.paused) return new Response(PAGE, { status: 503, headers: { "content-type": "text/plain" } });
      if (route === "/api/health") return json({ app: "duskbot" });
      if (route === "/api/auth/session") return json({ kind: "session" });
      if (route === "/.well-known/duskbot/environment") return json({ version: "0.2.31" });
      return json({}, 404);
    },
    power: gate,
    go: async (url, origin) => { w.went.push([url, origin]); w.url = url; },
    showLocal: () => {}, publish: () => {}, now, timers,
  });
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
  w.seen = () => {
    if (w.url.startsWith(CLOUD)) return "cloud";
    const view = w.home.view();
    return view.screen === "asleep" && view.waking ? "waking" : view.screen;
  };
  return w;
}

test("the provider's pause page is told from the home's own answers", () => {
  assert.equal(providerPausePage(PAGE), true);
  assert.equal(providerPausePage("Sandbox Offline"), true);
  assert.equal(providerPausePage("This dusk bot is asleep. It wakes when someone uses it."), false);
  assert.equal(providerPausePage('{"app":"duskbot"}'), false);
  assert.equal(providerPausePage(undefined), false);
});

test("a cloud whose machine the provider paused shows waking, never Can't reach or the provider's page, and opens by itself", async () => {
  const w = pausedWorld();
  await w.home.show();
  await w.flush();
  const seen = [];
  for (let at = 0; at < 60_000 && w.seen() !== "cloud"; at += 1_000) { seen.push(w.seen()); await w.later(1_000); }
  assert.ok(!seen.includes("offline"), `never Can't reach: ${[...new Set(seen)].join(", ")}`);
  assert.ok(seen.includes("waking"), "the waking screen shows while it resumes");
  assert.equal(w.seen(), "cloud", "opens by itself once it answers");
  assert.deepEqual(w.wakes, [{ intent: "click", paused: true }], "one resume, asked with the page named");
  assert.ok(w.clock - 1_000_000 <= 8_000 + 6_000, "within seconds of the machine answering");
});

test("a provider that keeps refusing is the offline screen after 5 min, and Try again resumes it once the provider answers", async () => {
  const w = pausedWorld({ resumeMs: Infinity });
  await w.home.show();
  await w.flush();
  const seen = [];
  for (let at = 0; at < 4 * 60_000; at += 1_000) { seen.push(w.seen()); await w.later(1_000); }
  assert.ok(!seen.includes("offline") && !seen.includes("cloud"), "4 min in: still the waking screen");
  await w.later(70_000);
  assert.equal(w.home.view().screen, "offline");
  w.paused = false;
  await w.home.retry();
  await w.flush();
  assert.equal(w.seen(), "cloud", "Try again opens it");
});
