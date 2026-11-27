import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createTrace, traceFolder, traceWanted } from "./ambient-trace.mjs";

test("the trace is off unless asked for, and writes one timed line per event to the logs folder", () => {
  assert.equal(traceWanted({}, null), false);
  assert.equal(traceWanted({ DUSK_AMBIENT_TRACE: "1" }, null), true);
  assert.equal(traceWanted({}, { trace: true }), true);
  assert.match(traceFolder("darwin"), /Library[\\/]Logs[\\/]Dusk Bot$/);
  const lines = [];
  let clock = Date.UTC(2026, 10, 10, 9, 30, 0, 120);
  const trace = createTrace({ folder: "/tmp/x", now: () => clock, write: (file, line) => lines.push([file, line]) });
  trace("island", "page:pointer-leave");
  clock += 151;
  trace("island", "win:blur", "");
  assert.deepEqual(lines.map(([file]) => file), [join("/tmp/x", "ambient-trace.log"), join("/tmp/x", "ambient-trace.log")]);
  assert.equal(lines[0][1], "09:30:00.120 +      0ms island page:pointer-leave\n");
  assert.equal(lines[1][1], "09:30:00.271 +    151ms island win:blur\n");
});
