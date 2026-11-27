import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createRoutineWakeHold } from "./routine-wake.mjs";
import { createSystemAwake, systemAwakeCommand } from "./system-awake.mjs";

test("macOS holds caffeinate -s tied to the app; Windows holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED in a hidden PowerShell", () => {
  assert.deepEqual(systemAwakeCommand("darwin", 4242), { file: "/usr/bin/caffeinate", args: ["-s", "-w", "4242"] });
  const windows = systemAwakeCommand("win32", 4242);
  assert.equal(windows.file, "powershell.exe");
  assert.ok(windows.args.includes("Hidden"));
  const script = windows.args.at(-1);
  assert.match(script, /SetThreadExecutionState\(\[uint32\]0x80000001\)/);
  assert.match(script, /Wait-Process -Id 4242/);
  assert.equal(systemAwakeCommand("linux", 4242), null);
});

function fakeSpawn() {
  const children = [];
  const spawn = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), { file, args, options, killed: false, kill() { this.killed = true; this.emit("exit", null); } });
    children.push(child);
    return child;
  };
  return { spawn, children };
}

test("one helper at a time, stopped on release, started again after it exits on its own", () => {
  const { spawn, children } = fakeSpawn();
  const awake = createSystemAwake({ platform: "darwin", parentPid: 7, spawn });
  awake.start();
  awake.start();
  assert.equal(children.length, 1);
  assert.equal(children[0].options.windowsHide, true);
  awake.stop();
  assert.equal(children[0].killed, true);
  assert.equal(awake.holding(), false);
  awake.start();
  children[1].emit("exit", 1);
  assert.equal(awake.holding(), false);
  awake.start();
  assert.equal(children.length, 3);
});

test("the routine wake hold takes the system assertion only while something is due or running, never on battery", async () => {
  const calls = [];
  const systemAwake = { start: () => calls.push("start"), stop: () => calls.push("stop") };
  let status = { hold: true, reason: "due", at: Date.now() + 60_000 };
  let battery = false;
  const blocker = { start: () => 1, stop() {}, isStarted: () => true };
  const hold = createRoutineWakeHold({ fetchStatus: async () => status, isOnBattery: () => battery, blocker, settings: () => ({ keepAwake: true, pluggedIn: false }), systemAwake });
  await hold.poll();
  assert.deepEqual(calls, ["start"]);
  battery = true;
  await hold.poll();
  assert.deepEqual(calls, ["start", "stop"]);
  battery = false;
  status = { hold: false };
  await hold.poll();
  assert.deepEqual(calls, ["start", "stop", "stop"]);
  status = { hold: true, reason: "running" };
  await hold.poll();
  hold.stop();
  assert.deepEqual(calls.slice(-2), ["start", "stop"]);
});
