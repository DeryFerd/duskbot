import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { APP_SUSPENSION_BLOCKER, DISPLAY_SLEEP_BLOCKER, createCompanionWakeHold, keepAwakeBlockerType } from "./companion-wake.mjs";

function fakeBlocker() {
  let nextId = 1;
  const active = new Map();
  const calls = [];
  return {
    calls,
    active,
    start(type) { const id = nextId++; active.set(id, type); calls.push(["start", type, id]); return id; },
    stop(id) { active.delete(id); calls.push(["stop", id]); },
    isStarted: (id) => active.has(id),
  };
}

test("a Windows PC on power keeps its display awake, so Modern Standby does not suspend the app; elsewhere nothing changes", () => {
  assert.equal(keepAwakeBlockerType({ platform: "win32", onBattery: false }), DISPLAY_SLEEP_BLOCKER);
  assert.equal(keepAwakeBlockerType({ platform: "win32", onBattery: true }), APP_SUSPENSION_BLOCKER);
  assert.equal(keepAwakeBlockerType({ platform: "darwin", onBattery: false }), APP_SUSPENSION_BLOCKER);
  assert.equal(keepAwakeBlockerType({ platform: "darwin", onBattery: true }), APP_SUSPENSION_BLOCKER);
  assert.equal(keepAwakeBlockerType({ platform: "linux", onBattery: false }), APP_SUSPENSION_BLOCKER);
});

test("on Windows the hold swaps type on a plug or unplug without a gap, and stop releases it and the listeners", () => {
  const blocker = fakeBlocker();
  const powerMonitor = new EventEmitter();
  let onBattery = false;
  const hold = createCompanionWakeHold({ blocker, platform: "win32", isOnBattery: () => onBattery });
  hold.watchPower(powerMonitor);
  assert.deepEqual(blocker.calls, []);

  assert.equal(hold.sync(true, true), DISPLAY_SLEEP_BLOCKER);
  assert.equal(hold.sync(true, true), DISPLAY_SLEEP_BLOCKER);
  assert.deepEqual(blocker.calls, [["start", DISPLAY_SLEEP_BLOCKER, 1]]);

  onBattery = true;
  powerMonitor.emit("on-battery");
  assert.equal(hold.type(), APP_SUSPENSION_BLOCKER);
  assert.deepEqual(blocker.calls.slice(1), [["start", APP_SUSPENSION_BLOCKER, 2], ["stop", 1]]);

  onBattery = false;
  powerMonitor.emit("on-ac");
  assert.equal(hold.type(), DISPLAY_SLEEP_BLOCKER);
  assert.equal(blocker.active.size, 1);

  hold.stop();
  assert.equal(blocker.active.size, 0);
  assert.equal(hold.sync(true, true), null);
  assert.equal(powerMonitor.listenerCount("on-ac"), 0);
  assert.equal(powerMonitor.listenerCount("on-battery"), 0);
});

test("a hold taken before the app was ready is corrected once power can be read", () => {
  const blocker = fakeBlocker();
  let ready = false;
  const hold = createCompanionWakeHold({ blocker, platform: "win32", isOnBattery: () => ready });
  assert.equal(hold.sync(true, true), DISPLAY_SLEEP_BLOCKER);
  ready = true;
  hold.watchPower(new EventEmitter());
  assert.equal(hold.type(), APP_SUSPENSION_BLOCKER);
  assert.equal(blocker.active.size, 1);
});

test("on a Mac the hold is the app-suspension one on battery too, and turning keep awake off releases it", () => {
  const blocker = fakeBlocker();
  const powerMonitor = new EventEmitter();
  const hold = createCompanionWakeHold({ blocker, platform: "darwin", isOnBattery: () => { throw new Error("unavailable"); } });
  hold.watchPower(powerMonitor);
  assert.equal(powerMonitor.listenerCount("on-ac"), 0);
  assert.equal(hold.sync(true, true), APP_SUSPENSION_BLOCKER);
  assert.equal(hold.sync(true, false), null);
  assert.equal(hold.sync(false, true), null);
  assert.equal(blocker.active.size, 0);
});
