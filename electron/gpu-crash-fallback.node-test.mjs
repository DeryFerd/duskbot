import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGpuCrashWatch, GPU_OFF_MS, GPU_WINDOW_MS, gpuOffForCrashes } from "./gpu-crash-fallback.mjs";

const fileIn = () => join(mkdtempSync(join(tmpdir(), "gpu-")), "gpu-crashes.json");
const gpu = (reason = "crashed", exitCode = 34) => ({ type: "GPU", reason, exitCode });

test("three GPU crashes within ten minutes turn hardware acceleration off from the next launch", () => {
  const file = fileIn();
  let now = 1_000_000;
  const watch = createGpuCrashWatch({ file, now: () => now });
  assert.equal(gpuOffForCrashes({ file, now, env: {} }), false);
  assert.equal(watch.gone(gpu()), false);
  now += 60_000;
  assert.equal(watch.gone(gpu("abnormal-exit")), false);
  assert.equal(gpuOffForCrashes({ file, now, env: {} }), false);
  now += 60_000;
  assert.equal(watch.gone(gpu()), true);
  assert.equal(gpuOffForCrashes({ file, now, env: {} }), true);
  assert.equal(watch.gone(gpu()), false, "already off: nothing more to say");
});

test("the count spans launches (a crash loop restarts the app), but crashes far apart never add up", () => {
  const file = fileIn();
  let now = 5_000_000;
  createGpuCrashWatch({ file, now: () => now }).gone(gpu());
  now += 30_000;
  createGpuCrashWatch({ file, now: () => now }).gone(gpu());
  now += 30_000;
  assert.equal(createGpuCrashWatch({ file, now: () => now }).gone(gpu()), true);

  const other = fileIn();
  let at = 9_000_000;
  const watch = createGpuCrashWatch({ file: other, now: () => at });
  for (let i = 0; i < 5; i += 1) { assert.equal(watch.gone(gpu()), false); at += GPU_WINDOW_MS; }
  assert.equal(gpuOffForCrashes({ file: other, now: at, env: {} }), false);
});

test("other processes, a clean exit or a kill never count", () => {
  const file = fileIn();
  const watch = createGpuCrashWatch({ file, now: () => 1 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(watch.gone({ type: "Utility", reason: "crashed", exitCode: 1 }), false);
    assert.equal(watch.gone(gpu("clean-exit", 0)), false);
    assert.equal(watch.gone(gpu("killed", 1)), false);
  }
  assert.equal(gpuOffForCrashes({ file, now: 1, env: {} }), false);
});

test("the GPU is tried again after a month, and DUSK_GPU=on or a broken file keep it on", () => {
  const file = fileIn();
  writeFileSync(file, JSON.stringify({ crashes: [], offSince: 100 }));
  assert.equal(gpuOffForCrashes({ file, now: 100 + GPU_OFF_MS - 1, env: {} }), true);
  assert.equal(gpuOffForCrashes({ file, now: 100 + GPU_OFF_MS, env: {} }), false);
  assert.equal(gpuOffForCrashes({ file, now: 200, env: { DUSK_GPU: "on" } }), false);
  writeFileSync(file, "{not json");
  assert.equal(gpuOffForCrashes({ file, now: 200, env: {} }), false);
  const watch = createGpuCrashWatch({ file, now: () => 300 });
  watch.gone(gpu());
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { crashes: [300], offSince: null });
});
