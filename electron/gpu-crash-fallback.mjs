import fs from "node:fs";

// Chromium's own fallback to software after repeated GPU process crashes lasts one launch, so a driver that keeps
// losing its device (Windows, exit 34) crashes it again on every launch. GPU_CRASHES within GPU_WINDOW_MS turn hardware
// acceleration off from the next launch for GPU_OFF_MS; DUSK_GPU=on keeps it on.
export const GPU_CRASHES = 3;
export const GPU_WINDOW_MS = 10 * 60_000;
export const GPU_OFF_MS = 30 * 24 * 60 * 60_000;
const GONE = new Set(["crashed", "abnormal-exit", "launch-failed", "integrity-failure", "oom"]);

function read(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      crashes: Array.isArray(state?.crashes) ? state.crashes.filter(Number.isFinite) : [],
      offSince: Number.isFinite(state?.offSince) ? state.offSince : null,
    };
  } catch {
    return { crashes: [], offSince: null };
  }
}

/** whether this launch runs without hardware acceleration, because the GPU process crashed again and again lately */
export function gpuOffForCrashes({ file, now = Date.now(), env = process.env }) {
  if (env.DUSK_GPU === "on") return false;
  const { offSince } = read(file);
  return offSince !== null && now >= offSince && now - offSince < GPU_OFF_MS;
}

/** hears child-process-gone; `gone(details)` is true when this crash turned hardware acceleration off for next launch */
export function createGpuCrashWatch({ file, now = () => Date.now(), log = () => {} }) {
  return {
    gone(details) {
      if (details?.type !== "GPU" || !GONE.has(details?.reason)) return false;
      const at = now(), state = read(file);
      if (state.offSince !== null && at - state.offSince < GPU_OFF_MS) return false;
      const crashes = [...state.crashes.filter((t) => at - t < GPU_WINDOW_MS && t <= at), at];
      const off = crashes.length >= GPU_CRASHES;
      try {
        fs.writeFileSync(file, JSON.stringify(off ? { crashes: [], offSince: at } : { crashes, offSince: null }));
      } catch (error) {
        log(`gpu: could not remember the crash (${error instanceof Error ? error.message : String(error)})`);
        return false;
      }
      if (off) log(`gpu: the GPU process crashed ${crashes.length} times in ${GPU_WINDOW_MS / 60_000} minutes (${details.reason}, exit ${details.exitCode}); hardware acceleration is off from the next launch`);
      return off;
    },
  };
}
