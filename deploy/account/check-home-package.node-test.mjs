import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageSsh } from "./package-ssh.mjs";

const SCRIPT = fileURLToPath(new URL("./check-home-package.mjs", import.meta.url));
const SHA = "a".repeat(64);
const signature = (sha) => `x.y.${Buffer.from(JSON.stringify({ kind: "home-package", sha256: sha, version: "1.2.3" })).toString("base64url")}`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "dusk-pkg-check-"));
  const envFile = join(dir, "env");
  writeFileSync(envFile, `DUSK_MANAGED_HOME_PACKAGE_FILE=/var/lib/x/omb-home.tgz\nDUSK_MANAGED_HOME_PACKAGE_SIGNATURE_FILE=/var/lib/x/omb-home.tgz.sig\nDUSK_MANAGED_HOME_PACKAGE_SHA256=${SHA}\n`, { mode: 0o600 });
  // a stand-in ssh on PATH: records its arguments and answers as the VPS would
  const bin = join(dir, "bin"), argsFile = join(dir, "ssh-args");
  execFileSync("mkdir", [bin]);
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho ${SHA}\necho '${signature(SHA)}'\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args, envFile], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
  return { run, sshArgs: () => readFileSync(argsFile, "utf8").trim().split("\n"), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("reaches contabo by default, another host or a jump when told", () => {
  assert.deepEqual(packageSsh({}).args.slice(-1), ["contabo"]);
  assert.deepEqual(packageSsh({ DUSK_PACKAGE_SSH_HOST: "root@169.58.211.160", DUSK_PACKAGE_SSH_JUMP: "oracle" }).args.slice(-3), ["-J", "oracle", "root@169.58.211.160"]);
  assert.equal(packageSsh({ DUSK_PACKAGE_SSH_HOST: "root@169.58.211.160", DUSK_PACKAGE_SSH_JUMP: "oracle" }).label, "root@169.58.211.160 via oracle");
});

test("refuses a host or jump ssh would read as an option", () => {
  assert.throws(() => packageSsh({ DUSK_PACKAGE_SSH_HOST: "-oProxyCommand=touch /tmp/x" }), /DUSK_PACKAGE_SSH_HOST/);
  assert.throws(() => packageSsh({ DUSK_PACKAGE_SSH_JUMP: "-oProxyCommand=x" }), /DUSK_PACKAGE_SSH_JUMP/);
  assert.throws(() => packageSsh({ DUSK_PACKAGE_SSH_HOST: "host;rm" }), /DUSK_PACKAGE_SSH_HOST/);
});

test("the check runs ssh through the jump and host it was given, and passes when the package agrees", () => {
  const s = sandbox();
  try {
    const out = s.run([], { DUSK_PACKAGE_SSH_HOST: "root@169.58.211.160", DUSK_PACKAGE_SSH_JUMP: "oracle" });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /home package: \/var\/lib\/x\/omb-home.tgz aaaaaaaaaaaa, signed 1.2.3/);
    const args = s.sshArgs();
    assert.deepEqual(args.slice(4, 7), ["-J", "oracle", "root@169.58.211.160"]);
    const plain = s.run([]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(s.sshArgs()[4], "contabo");
  } finally { s.close(); }
});

test("--dry-run prints the ssh command and runs nothing; a bad host refuses the deploy", () => {
  const s = sandbox();
  try {
    const dry = s.run(["--dry-run"], { DUSK_PACKAGE_SSH_HOST: "root@169.58.211.160", DUSK_PACKAGE_SSH_JUMP: "oracle" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would run ssh -o BatchMode=yes -o ConnectTimeout=20 -J oracle root@169\.58\.211\.160 'sha256sum/);
    assert.throws(() => s.sshArgs());
    const bad = s.run([], { DUSK_PACKAGE_SSH_HOST: "-oProxyCommand=x" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /refusing to deploy: DUSK_PACKAGE_SSH_HOST/);
  } finally { s.close(); }
});
