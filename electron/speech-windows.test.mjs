import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ launches: [] }));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => tmpdir() } }));
vi.mock("node:child_process", () => ({
  spawn: (file, args, options) => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null, signalCode: null, killed: 0 });
    proc.kill = () => { proc.killed += 1; };
    const arg = flag => args[args.indexOf(flag) + 1];
    fixture.launches.push({ proc, file, args, options, stop: arg("-StopFile"), finish: arg("-FinishFile") });
    return proc;
  },
}));

Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/synthetic-speech-resources" });
const { startSpeech, stopSpeech, finishSpeech, speechBusy } = await import("./speech.mjs");

const realPlatform = process.platform;
const realRoot = process.env.SystemRoot;
const sinkOf = () => {
  const heard = { lines: [], levels: [], ends: [] };
  return { heard, sink: { transcript: line => heard.lines.push(line), level: v => heard.levels.push(v), end: info => heard.ends.push(info), replaced: () => {} } };
};
const begin = (options) => {
  const { heard, sink } = sinkOf();
  startSpeech(sink, options);
  return { ...fixture.launches.at(-1), heard, sink };
};
const write = (session, text) => session.proc.stdout.write(text);
const lines = (session, ...objects) => write(session, objects.map(o => `${JSON.stringify(o)}\r\n`).join(""));
const flushed = () => new Promise(resolve => setImmediate(resolve));
const close = async (session, code = 0) => {
  await flushed();
  session.proc.stdout.end();
  await flushed();
  session.proc.emit("close", code);
};

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  process.env.SystemRoot = "D:\\Win";
});
afterEach(() => {
  stopSpeech();
  for (const session of fixture.launches) session.proc.emit("close", 0);
  fixture.launches.length = 0;
  Object.defineProperty(process, "platform", { configurable: true, value: realPlatform });
  if (realRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = realRoot;
  vi.useRealTimers();
});

describe("built-in Windows speech", () => {
  it("runs the shipped script in Windows PowerShell with piped output and no window", () => {
    const session = begin({ endpointMs: 900, locale: "de-DE", finishOnRelease: ["control"] });
    expect(session.file).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(session.args.slice(0, 6)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join("/synthetic-speech-resources", "windows-speech.ps1")]);
    expect(session.args.slice(6)).toEqual(["-EndpointMs", "900", "-Locale", "de-DE", "-StopFile", session.stop, "-FinishFile", session.finish]);
    expect(session.options).toEqual({ stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    expect(session.args).not.toContain("--finish-on-release");
    expect(speechBusy()).toBe(true);
  });

  it("leaves out endpointing and a locale it was not given or cannot trust", () => {
    const session = begin({ locale: "en-US; rm -rf" });
    expect(session.args.slice(6)).toEqual(["-StopFile", session.stop, "-FinishFile", session.finish]);
  });

  it("delivers partials, utterances, levels and the final line, even split across reads", async () => {
    const session = begin();
    lines(session, { level: 0.2 }, { level: 0.7 }, { partial: true, text: "größe" });
    write(session, '{"partial":true,"text":"größe zählt","utteranceFinal":true}\n{"partial":true,"text":"größe zählt imm');
    write(session, 'er"}\n{"level":3}\n');
    lines(session, { partial: false, text: "größe zählt immer" });
    await close(session, 0);
    expect(session.heard.levels).toEqual([0.7, 1]);
    expect(session.heard.lines.map(line => [line.text, line.partial])).toEqual([
      ["größe", true], ["größe zählt", true], ["größe zählt immer", true], ["größe zählt immer", false],
    ]);
    expect(session.heard.ends).toEqual([{ code: 0, reason: "completed" }]);
    expect(speechBusy()).toBe(false);
  });

  it("passes the script's error code through", async () => {
    for (const code of ["recognizer-unavailable", "mic-failed", "recognition-error"]) {
      const session = begin();
      lines(session, { error: code });
      await close(session, 1);
      expect(session.heard.ends).toEqual([{ code: 1, reason: code }]);
    }
  });

  it("calls a powershell that exits without a final line a helper exit, and one that cannot start a start failure", async () => {
    const quiet = begin();
    await close(quiet, 0);
    expect(quiet.heard.ends).toEqual([{ code: 1, reason: "helper-exited" }]);
    const missing = begin();
    missing.proc.emit("error", new Error("spawn ENOENT"));
    expect(missing.heard.ends).toEqual([{ code: 1, reason: "helper-start-failed" }]);
    expect(speechBusy()).toBe(false);
  });

  it("finish asks the script for its final line; stop asks it to quit and kills it if it does not", async () => {
    vi.useFakeTimers();
    const session = begin();
    finishSpeech(session.sink);
    expect(existsSync(session.finish)).toBe(true);
    expect(existsSync(session.stop)).toBe(false);
    stopSpeech(session.sink);
    expect(existsSync(session.stop)).toBe(true);
    expect(speechBusy()).toBe(false);
    vi.advanceTimersByTime(1_499);
    expect(session.proc.killed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(session.proc.killed).toBe(1);

    const polite = begin();
    stopSpeech(polite.sink);
    polite.proc.exitCode = 0;
    vi.advanceTimersByTime(2_000);
    expect(polite.proc.killed).toBe(0);
    expect(polite.heard.ends).toEqual([]);
  });

  it("a stopped session's late lines and exit never reach its sink", async () => {
    const session = begin();
    stopSpeech();
    lines(session, { partial: false, text: "too late" });
    await close(session, 0);
    expect(session.heard.lines).toEqual([]);
    expect(session.heard.ends).toEqual([]);
  });

  it("still turns other desktops away", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    const { heard, sink } = sinkOf();
    startSpeech(sink);
    expect(heard.ends).toEqual([{ code: 2, reason: "unsupported-platform" }]);
    expect(fixture.launches).toEqual([]);
  });
});
