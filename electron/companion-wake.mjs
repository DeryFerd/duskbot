// Windows 11 with Modern Standby (S0 low power idle) enters standby as soon as the display turns off on idle.
// Chromium maps "prevent-app-suspension" to PowerRequestExecutionRequired, which lets the display turn off, so only
// "prevent-display-sleep" (PowerRequestDisplayRequired) keeps such a PC reachable. It is held on AC power only.
export const APP_SUSPENSION_BLOCKER = "prevent-app-suspension";
export const DISPLAY_SLEEP_BLOCKER = "prevent-display-sleep";

/** The powerSaveBlocker type that keeps this computer awake for background work, or null for none. */
export function keepAwakeBlockerType({ platform = process.platform, onBattery = false } = {}) {
  return platform === "win32" && !onBattery ? DISPLAY_SLEEP_BLOCKER : APP_SUSPENSION_BLOCKER;
}

/**
 * `blocker` is Electron's powerSaveBlocker. `sync(enabled, keepAwake)` follows the remote access setting;
 * `watchPower(powerMonitor)` (once the app is ready) re-picks the type on a plug or unplug; `stop()` releases for good.
 */
export function createCompanionWakeHold({ blocker, platform = process.platform, isOnBattery = () => false, log = () => {} }) {
  let id = null, type = null, wanted = false, stopped = false, watched = null;
  const battery = () => { try { return isOnBattery() === true; } catch { return false; } };

  function evaluate() {
    const next = wanted && !stopped ? keepAwakeBlockerType({ platform, onBattery: battery() }) : null;
    if (next === type && (next === null || blocker.isStarted(id))) return type;
    const previous = id;
    id = next === null ? null : blocker.start(next);
    type = next;
    if (previous !== null && blocker.isStarted(previous)) blocker.stop(previous);
    log(next === null ? "companion wake: released" : `companion wake: holding this computer awake (${next})`);
    return type;
  }

  return {
    sync(enabled, keepAwake) {
      wanted = Boolean(enabled && keepAwake);
      return evaluate();
    },
    watchPower(powerMonitor) {
      if (watched || stopped || platform !== "win32" || !powerMonitor?.on) return;
      watched = powerMonitor;
      powerMonitor.on("on-ac", evaluate);
      powerMonitor.on("on-battery", evaluate);
      evaluate();
    },
    stop() {
      stopped = true;
      watched?.removeListener?.("on-ac", evaluate);
      watched?.removeListener?.("on-battery", evaluate);
      watched = null;
      evaluate();
    },
    type: () => type,
  };
}
