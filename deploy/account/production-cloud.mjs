#!/usr/bin/env node
// Prepares dusk cloud on the production account service: the dusk.env names it needs, and a check that the home
// package the release flow placed matches its signature and sha256. Dry run unless --apply; idempotent (only what is missing or different is
// written); prints names, paths and sha256s, never a secret's value.
//
//   node deploy/account/production-cloud.mjs env [--apply]                         the [production] names below
//   node deploy/account/production-cloud.mjs package-check <preview|production>   the release flow's home package, its
//                                                                                signature and dusk.env's sha256 agree (read only)
// The deploys themselves are in deploy/account/PRODUCTION-CLOUD.md.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { packageSsh } from "./package-ssh.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = process.env.DUSK_ENV || join(homedir(), ".config/duskbot/dusk.env");
const [step, ...rest] = process.argv.slice(2);
const apply = rest.includes("--apply");
const say = (line) => console.log(`${apply ? "" : "[dry run] "}${line}`);
const fail = (line) => { console.error(`production-cloud: ${line}`); process.exit(1); };
const secret = () => randomBytes(32).toString("base64url");

function readEnv() {
  if ((statSync(source).mode & 0o777) !== 0o600) fail(`${source} must be mode 600`);
  const lines = readFileSync(source, "utf8").split("\n");
  const names = new Map(lines.map((line, i) => [/^([A-Z0-9_]+)=/.exec(line)?.[1], i]).filter(([name]) => name));
  return { lines, names };
}
/** sets NAME=value at the end of `section` (before the next section header): new names are added, `replace` ones changed */
function setNames(section, wanted, { replace = [] } = {}) {
  const { lines, names } = readEnv();
  const changes = [];
  for (const [name, value] of wanted) {
    if (names.has(name) && !replace.includes(name)) { say(`${name}: already set, kept`); continue; }
    if (names.has(name) && lines[names.get(name)] === `${name}=${value}`) { say(`${name}: unchanged`); continue; }
    changes.push([name, value]);
    say(`${name}: ${names.has(name) ? "would change" : "would add"}${apply ? " (done)" : ""}`);
  }
  if (!apply || !changes.length) return;
  // the rollback for this step: cp -p <backup> dusk.env
  const backup = `${source}.bak-production-cloud-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(source, backup); chmodSync(backup, 0o600);
  console.log(`backup: ${backup}`);
  for (const [name, value] of changes) {
    if (names.has(name)) { lines[names.get(name)] = `${name}=${value}`; continue; }
    const head = lines.findIndex((line) => line.startsWith(`# [${section}]`));
    if (head < 0) fail(`no [${section}] section in ${source}`);
    let end = lines.findIndex((line, i) => i > head && /^#\s*\[[a-z]+\]/.test(line));
    if (end < 0) end = lines.length;
    while (end > head + 1 && lines[end - 1].trim() === "") end--;
    lines.splice(end, 0, `${name}=${value}`);
    names.clear(); lines.forEach((line, i) => { const n = /^([A-Z0-9_]+)=/.exec(line)?.[1]; if (n) names.set(n, i); });
  }
  writeFileSync(source, lines.join("\n"), { mode: 0o600 });
}

if (step === "env") {
  // billing stays off on production (nothing for sale before launch); App Review's cloud comes from its review grant.
  // the edge token is shared with preview's, so the one edge Worker (ROUTE_URL lists both services) needs no new secret
  setNames("production", [
    ["DUSK_MANAGED_PRODUCTION", "1"],
    ["INSTABOX_API_KEY_PRODUCTION", "${INSTABOX_API_KEY_PREVIEW}"],
    ["DUSK_MANAGED_PROVIDER_PLAN_PRODUCTION", "${DUSK_MANAGED_PROVIDER_PLAN_PREVIEW}"],
    ["DUSK_MANAGED_PUBLIC_DOMAIN_PRODUCTION", "dusk.bot"],
    ["DUSK_MANAGED_EDGE_TOKEN_PRODUCTION", "${DUSK_MANAGED_EDGE_TOKEN_PREVIEW}"],
    ["DUSK_CLOUD_SEAL_KEY_PRODUCTION", secret()],
    ["DUSK_OPS_TOKEN_PRODUCTION", secret()],
  ]);
  // the env file production would get must still build (references resolve, names end in _PRODUCTION)
  const probe = join(mkdtempSync(join(tmpdir(), "dusk-env-")), "env");
  try { execFileSync("node", [join(root, "deploy/env.mjs"), "production", probe], { stdio: "inherit" }); say(`production env builds (${readFileSync(probe, "utf8").split("\n").filter(Boolean).length} names)`); }
  finally { rmSync(dirname(probe), { recursive: true, force: true }); }
} else if (step === "package-check") {
  // home packages are built, signed and placed by the release flow only, always as <dir>/omb-home.tgz(.sig) with its
  // sha256 in dusk.env; this only checks that the file, its signature and the env agree before a deploy, and changes nothing
  const target = rest.find((arg) => arg === "preview" || arg === "production") ?? fail("package-check needs preview or production");
  const suffix = target.toUpperCase(), { lines, names } = readEnv();
  const value = (name) => { const i = names.get(name); return i === undefined ? null : lines[i].slice(name.length + 1).replace(/^(["'])(.*)\1$/, "$2"); };
  const file = value(`DUSK_MANAGED_HOME_PACKAGE_FILE_${suffix}`), sig = value(`DUSK_MANAGED_HOME_PACKAGE_SIGNATURE_FILE_${suffix}`), sha = value(`DUSK_MANAGED_HOME_PACKAGE_SHA256_${suffix}`);
  if (!file || !sig || !sha) fail(`dusk.env has no DUSK_MANAGED_HOME_PACKAGE_FILE/SIGNATURE_FILE/SHA256_${suffix}: the release flow places ${target}'s package first`);
  const there = execFileSync("ssh", [...packageSsh().args, `sha256sum '${file}' 2>/dev/null | cut -c1-64; test -s '${sig}' && echo sig; true`], { encoding: "utf8" }).split("\n");
  if (there[0] !== sha) fail(`${file} has sha256 ${there[0] ? `${there[0].slice(0, 12)}...` : "(missing)"}, dusk.env says ${sha.slice(0, 12)}...: do not deploy`);
  if (there[1] !== "sig") fail(`${sig} is missing or empty: do not deploy`);
  console.log(`${target}: ${file} matches dusk.env (sha256 ${sha.slice(0, 12)}...) and has its signature`);
} else {
  console.error("usage: production-cloud.mjs env [--apply] | package-check <preview|production>");
  process.exit(2);
}
