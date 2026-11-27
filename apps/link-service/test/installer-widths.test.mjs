import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const path = fileURLToPath(new URL("../install.sh", import.meta.url));
const script = readFileSync(path, "utf8");
const functions = script.replace(/\nmain "\$@"\s*$/, "\n");
const dir = mkdtempSync(join(tmpdir(), "omb-widths-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let runs = 0;

/** install.sh's own ui_init, phase, step and phase_end with the step's work stubbed (a 200 character log line, then
 * exit `rc`). `cols` runs it in a real terminal of that width (script(1) makes the pty, stty sets its width); without
 * it, stdout is a pipe. */
async function stepAt(env, { rc = 0, cols } = {}) {
  const work = join(dir, String(runs++));
  const file = `${work}.sh`;
  writeFileSync(file, `${functions}
${cols === undefined ? "" : `stty cols ${cols} rows 40 2>/dev/null`}
TMP=${work}/tmp LOGS=${work}/logs STATE=${work}/state PROGRESS=${work}/tmp/progress DEMO=""
mkdir -p "$TMP" "$LOGS" "$STATE"
report() { :; }; stream_lines() { :; }; show_asks() { :; }
ui_init
echo "cols=$COLS ui=$UI"
long_work() { printf '%0200d\\n' 0 | tr 0 x; sleep 0.4; return ${rc}; }
phase check
step check long_work
phase_end
echo "step done"
`);
  const environment = { PATH: process.env.PATH, HOME: dir, ...env };
  const argv = cols === undefined ? ["sh", [file]] : ["python3", ["-c", IN_A_TERMINAL, file]];
  const done = await run(argv[0], argv[1], { env: environment, timeout: 20_000 }).catch((error) => error);
  return { code: done.code ?? 0, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
}

// runs sh FILE on a fresh pty and passes on what it printed and its exit code
const IN_A_TERMINAL = `
import os, sys
pid, fd = os.forkpty()
if pid == 0:
    os.execvp("sh", ["sh", sys.argv[1]])
out = b""
while True:
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    out += data
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
`;

const widthError = /cut:|fold:|invalid|illegal|bad number|arithmetic/i;
const colsOf = (out) => Number(/cols=(\d+)/.exec(out)?.[1]);

// a terminal that reports a width of 0, or a narrow one (an ssh app on a phone), must never end the install: cut and
// fold refuse a width of 0 or less (`cut: range '1--1' was invalid`)
describe.skipIf(process.platform === "win32")("installer widths", () => {
  it("clamps every cut width it computes from the terminal", () => {
    expect(script.split("\n").filter(line => /cut -c1-\$\(\(COLS - TW/.test(line))).toEqual([]);
    expect(script).toMatch(/_ww=\$\(\(COLS - TW - 16\)\); \[ "\$_ww" -ge 20 \] \|\| _ww=20/);
  });

  it.each([
    ["COLUMNS=0 and no TERM", { COLUMNS: "0" }],
    ["COLUMNS empty", { COLUMNS: "" }],
    ["COLUMNS not a number", { COLUMNS: "wide", TERM: "xterm-256color" }],
    ["COLUMNS=47", { COLUMNS: "47", TERM: "xterm" }],
    ["TERM=dumb", { COLUMNS: "0", TERM: "dumb" }],
  ])("finishes a step when stdout is not a terminal, with %s", async (_name, env) => {
    const done = await stepAt(env);
    expect(done.out).not.toMatch(widthError);
    expect(done.out).toContain("ui=plain");
    expect(colsOf(done.out)).toBeGreaterThanOrEqual(20);
    expect(done.out).toContain("step done");
  });

  it.each([0, 1, 20, 30, 47, 48, 60, 120])("in a terminal %i columns wide, draws the step, its summary and a failure without a width error", async (cols) => {
    const ok = await stepAt({ TERM: "xterm-256color", COLUMNS: "0" }, { cols });
    expect(ok.out).toContain("ui=tty");
    expect(colsOf(ok.out)).toBeGreaterThanOrEqual(20);
    expect(ok.out).not.toMatch(widthError);
    expect(ok.out).toContain("step done");
    const failed = await stepAt({ TERM: "xterm-256color" }, { cols, rc: 1 });
    expect(failed.out).not.toMatch(widthError);
    expect(failed.out).toContain("couldn't finish");
    expect(failed.out).not.toContain("step done");
  });
});
