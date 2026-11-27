// A system-sleep assertion stronger than Electron's powerSaveBlocker, held only while a routine or a turn waiting for a
// usage limit is due within the hour and the computer is on power.
//
// macOS: powerSaveBlocker's "prevent-app-suspension" is an idle-sleep assertion; `caffeinate -s` takes
// PreventSystemSleep, which macOS honours only on AC power and which, on AC, also keeps a Mac awake with its lid closed.
// On battery nothing an app can hold stops a closed lid from sleeping the Mac.
// Windows: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) is held by the thread that set it, so a hidden
// PowerShell keeps it until it is stopped or this app exits. On a Modern Standby (S0ix) PC it stops the idle timeout
// from entering standby; closing the lid or pressing the power button still enters standby, which no app can refuse.
import { spawn as spawnChild } from "node:child_process";

const ES_CONTINUOUS_SYSTEM_REQUIRED = "0x80000001";

/** The command that holds the assertion until it is stopped or `parentPid` exits; null where there is none. */
export function systemAwakeCommand(platform, parentPid) {
  if (platform === "darwin") return { file: "/usr/bin/caffeinate", args: ["-s", "-w", String(parentPid)] };
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$k = Add-Type -Name Awake -Namespace DuskBot -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
      `if ($k::SetThreadExecutionState([uint32]${ES_CONTINUOUS_SYSTEM_REQUIRED}) -eq 0) { exit 3 }`,
      `Wait-Process -Id ${Number(parentPid)} -ErrorAction SilentlyContinue`,
    ].join("; ");
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script] };
  }
  return null;
}

/**
 * `deps`: platform, parentPid, spawn (node's), log(line). start() is idempotent, stop() ends the hold; a helper that
 * exits on its own is started again by the next start().
 */
export function createSystemAwake({ platform = process.platform, parentPid = process.pid, spawn = spawnChild, log } = {}) {
  let child = null;
  return {
    start() {
      if (child) return;
      const command = systemAwakeCommand(platform, parentPid);
      if (!command) return;
      try {
        const started = spawn(command.file, command.args, { stdio: "ignore", windowsHide: true, detached: false });
        child = started;
        started.once("error", (error) => { if (child === started) child = null; log?.(`system awake: could not hold (${error.message})`); });
        started.once("exit", (code) => { if (child === started) { child = null; if (code) log?.(`system awake: the hold ended (exit ${code})`); } });
        log?.(`system awake: holding (${command.file})`);
      } catch (error) {
        child = null;
        log?.(`system awake: could not hold (${error instanceof Error ? error.message : String(error)})`);
      }
    },
    stop() {
      const running = child;
      child = null;
      if (!running) return;
      try { running.kill(); } catch {}
      log?.("system awake: released");
    },
    holding: () => child !== null,
  };
}
