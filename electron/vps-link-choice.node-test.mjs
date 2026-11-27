// linking a server again (its setup line run once more) or its address moving must not fail on a computer that never
// chose a server of its own: own-home-choice.json is only written once one is chosen
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { jsonFile } from "./desktop-prefs.mjs";
import { ownHomeChoiceMoves } from "./vps-link-main.mjs";

test("retarget and rehome pass over a choice file that was never written", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "dusk-choice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moves = ownHomeChoiceMoves(jsonFile(path.join(dir, "own-home-choice.json")));
  assert.doesNotThrow(() => moves.retarget("https://old.ts.net", "https://new.ts.net"));
  assert.doesNotThrow(() => moves.rehome("env-old", { id: "env-new", origin: "https://box.ts.net" }));
});

test("a chosen server follows its new address and its new record", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "dusk-choice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "own-home-choice.json"), store = jsonFile(file);
  store.write({ v: 1, id: "env-old", origin: "https://old.ts.net", name: "box" });
  const moves = ownHomeChoiceMoves(store);
  moves.retarget("https://old.ts.net", "https://new.ts.net");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).origin, "https://new.ts.net");
  moves.rehome("env-old", { id: "env-new", origin: "https://box.ts.net" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { v: 1, id: "env-new", origin: "https://box.ts.net", name: "box" });
  moves.rehome("env-other", { id: "env-x", origin: "https://x.ts.net" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).id, "env-new");
});
