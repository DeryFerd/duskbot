import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BOX_OFF, runCheckScript, scriptCheckGate, scriptRoutineRefusal } from "./routine-script.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "dusk-cloud-script-")); dirs.push(dir); return dir; };

describe("script checks on dusk cloud", () => {
  const turn = { owned: true, room: false, guest: false, depth: 0, handedOff: false, outsideDriven: false, routineRun: false, personStarted: true, asksFirst: false };
  const clean = { readOutside: false, fullAccess: false, unfenced: false };

  it("may be set up by the owner in the box, never with full access", () => {
    expect(scriptCheckGate(turn, true, clean)).toEqual({ apply: true });
    expect(scriptCheckGate(turn, true, { ...clean, unfenced: true })).toEqual({ refused: expect.stringMatching(/dusk cloud/) });
    expect(scriptCheckGate({ ...turn, guest: true }, true, clean)).toEqual({ refused: expect.stringMatching(/Only the person/) });
    const script = { probe: { kind: "script", command: "x" } };
    expect(scriptRoutineRefusal(script, true, true)).toBeNull();
    expect(scriptRoutineRefusal({ probe: { ...script.probe, access: "full" } }, true, true)).toMatch(/dusk cloud/);
    expect(scriptRoutineRefusal(script, true, false)).toMatch(/owner/);
  });

  // the box is a Linux sandbox run under /bin/sh, which a Windows host has not
  it.skipIf(process.platform === "win32")("runs in the bot's box, and fails plainly when the box is off", async () => {
    const home = join(tempDir(), "home");
    expect(await runCheckScript("echo hi", { box: { wrap: () => null, botId: "b1", home } })).toEqual({ ok: false, error: BOX_OFF });
    const asked: unknown[] = [];
    let released = 0;
    const result = await runCheckScript("echo boxed", { box: { botId: "b1", home, wrap: (request) => {
      asked.push(request);
      return { command: request.command, args: [...request.args], env: { PATH: "/usr/bin:/bin" }, plan: { mounts: [] } as never, token: null, release: () => { released++; }, unbrokered: [], extraFds: [] };
    } } });
    expect(result).toEqual({ ok: true, output: "boxed\n" });
    expect(asked).toEqual([expect.objectContaining({ command: "/bin/sh", args: ["-c", "echo boxed"], botId: "b1", home })]);
    expect(released).toBe(1);
    expect(existsSync(home)).toBe(true);
  });
});
