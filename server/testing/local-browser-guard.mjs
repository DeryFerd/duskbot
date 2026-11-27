import childProcess from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const directory = process.env.DUSK_DATA_DIR;
if (!directory || directory !== process.env.HOME || process.env.DUSK_TEST_LOCAL_BROWSER_GUARD !== "1") {
  throw new Error("The local browser guard requires an explicitly isolated fixture");
}
writeFileSync(join(directory, "local-browser-guard.json"), JSON.stringify({ installed: true, platform: process.platform }));
const log = join(directory, "container-attempts.jsonl");
writeFileSync(log, "");
const refuse = (command) => {
  const name = basename(String(command)).toLowerCase().replace(/\.exe$/, "");
  if (name === "docker" || name === "podman") {
    appendFileSync(log, JSON.stringify({ command: name }) + "\n");
    throw new Error("The native browser fixture refuses container commands");
  }
};
for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[method];
  const guarded = function(command, ...args) {
    refuse(command);
    return Reflect.apply(original, this, [command, ...args]);
  };
  // execFile carries its own promisified form ({ stdout, stderr }); without it util.promisify resolves with stdout alone
  const promised = original[promisify.custom];
  if (promised) guarded[promisify.custom] = function(command, ...args) {
    try { refuse(command); } catch (error) { return Promise.reject(error); }
    return Reflect.apply(promised, this, [command, ...args]);
  };
  childProcess[method] = guarded;
}
syncBuiltinESMExports();
