// a release's notes, from what changed since the last tag: the curated lines in docs/releases/unreleased.json first
// (plain user words, one line each, with their area and issue or PR), then a draft line for every user-facing commit
// nobody curated, the merged PRs and the issues closed in the window. Writes the GitHub release body (Markdown: what's
// new by area, downloads, how to update each kind of install, every change folded away) and the changelog.json entry.
//
//   node scripts/release-notes.ts 0.2.32 [--since v0.2.31] [--to HEAD] [--date 2026-11-27] [--out release/notes] [--apply] [--offline]
//
// --apply puts the entry at the top of apps/site/public/landing/releases/changelog.json (replacing one for the same
// version) and empties unreleased.json. --offline skips GitHub (no PR or issue lists). Read the draft lines before
// applying: anything left in "Also in this release" stays out of changelog.json until someone writes it in user words.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { releaseAssets, DOWNLOADS_REPO, SERVER_IMAGE, SOURCE_REPO } from "./release-assets.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CHANGELOG = join(ROOT, "apps", "site", "public", "landing", "releases", "changelog.json");
export const UNRELEASED = join(ROOT, "docs", "releases", "unreleased.json");

export type Area = "desktop" | "phone" | "server" | "cli" | "all";
export interface Item { text: string; area: Area; kind?: "new" | "better" | "fixed"; icon?: string; issue?: number; pr?: number }
export interface Entry { version: string; date: string; title?: string; items: Item[] }
export interface Changelog { v: 1; releases: Entry[] }
export interface Commit { sha: string; subject: string; files: string[] }

export const AREA_ORDER: readonly Area[] = ["all", "desktop", "phone", "server", "cli"];
export const AREA_LABEL: Record<Area, string> = { all: "Everywhere", desktop: "Desktop app", phone: "Phone app", server: "Server and bots", cli: "CLI" };

// commits that change how dusk bot is built or tested, not what a person sees
const INTERNAL_SCOPE = /^(release|ci|ci scope|test|tests|e2e|user-sim|locale lines|locale(?:s)|lint|ratchet|agents catalog|wake hold test|brand screen studio|store launch|asc helper|docs|site|chore|build|deps|typecheck|bench|eval|stress)\b/i;
const INTERNAL_PATH = /^(\.github\/|scripts\/|docs\/|apps\/site\/|tests?\/|e2e\/|benchmarks?\/)|\.test\.|\.node-test\.|\.e2e\./;

/** the area a change is for, from the files it touched */
export function areaOf(files: readonly string[]): Area | null {
  const user = files.filter(f => !INTERNAL_PATH.test(f));
  if (!user.length) return null;
  const hit = new Set<Area>();
  for (const f of user) {
    if (/^server\/cli[-.]|^server\/duskbot\.ts|^server\/headless\//.test(f)) hit.add("cli");
    else if (f.startsWith("apps/mobile/")) hit.add("phone");
    else if (/^(src|electron)\//.test(f)) hit.add("desktop");
    else if (/^(server|shared|apps\/link-service|apps\/cloud-service|deploy|skills)\//.test(f)) hit.add("server");
  }
  if (!hit.size) return null;
  if (hit.size === 1) return [...hit][0]!;
  if (hit.has("desktop") && hit.has("phone")) return "all";
  return hit.has("server") ? "server" : hit.has("desktop") ? "desktop" : [...hit][0]!;
}

/** "scope: a thing changed; why it matters" -> "A thing changed", with the #N it names; null for internal commits */
export function draftLine(c: Commit): Item | null {
  const scope = /^([\w .+/-]{1,40}):\s+/.exec(c.subject);
  if (scope && INTERNAL_SCOPE.test(scope[1]!.trim())) return null;
  if (/^(merge|revert|release[ :])/i.test(c.subject)) return null;
  const area = areaOf(c.files);
  if (!area) return null;
  const refs = [...c.subject.matchAll(/(?:\(|\b(?:refs|fixes|closes)\s+)#(\d+)\)?/gi)].map(m => Number(m[1]));
  let text = (scope ? c.subject.slice(scope[0].length) : c.subject).replace(/\s*\((?:refs |fixes )?#\d+\)/gi, "").replace(/\s*\b(?:refs|fixes|closes)\s+#\d+/gi, "");
  text = text.split(/;\s|, so that |\. /)[0]!.trim().replace(/[.;,:]+$/, "");
  if (text.length > 160) text = `${text.slice(0, 157).replace(/\s+\S*$/, "")}…`;
  if (!text) return null;
  // the scope stays as a lead-in so a draft line still says what it is about
  const raw = scope ? scope[1]!.trim() : "";
  const lead = /^ios\b/i.test(raw) ? `iOS${raw.slice(3)}` : raw;
  text = lead ? `${lead.startsWith("iOS") ? lead : lead[0]!.toUpperCase() + lead.slice(1)}: ${text}` : text[0]!.toUpperCase() + text.slice(1);
  const item: Item = { text: text.endsWith("…") ? text : `${text}.`, area };
  if (refs[0]) item.pr = refs[0];
  return item;
}

export interface Gathered { commits: Commit[]; prs: { number: number; title: string; author: string }[]; issues: { number: number; title: string }[] }

/** sorts a commit's #N into pr or issue once the window's lists are known */
export function settleRefs(item: Item, prs: ReadonlySet<number>, issues: ReadonlySet<number>): Item {
  const n = item.pr ?? item.issue;
  if (!n) return item;
  const { pr: _pr, issue: _issue, ...rest } = item;
  if (issues.has(n) && !prs.has(n)) return { ...rest, issue: n };
  return { ...rest, pr: n };
}

/** the curated lines: unreleased.json's, or once --apply moved them, the changelog.json entry of the same version */
export function curatedFor(version: string, unreleased: { items?: Item[]; title?: string }, log: Changelog | null): { items: Item[]; title?: string } {
  if (unreleased.items?.length) return { items: unreleased.items, title: unreleased.title };
  const applied = log?.releases.find(r => r.version === version);
  return applied ? { items: applied.items, title: applied.title ?? unreleased.title } : { items: [], title: unreleased.title };
}

export function buildEntry(version: string, date: string, curated: readonly Item[], g: Gathered, title?: string): { entry: Entry; drafts: Item[] } {
  const prSet = new Set(g.prs.map(p => p.number)), issueSet = new Set(g.issues.map(i => i.number));
  const covered = new Set(curated.flatMap(i => [i.pr, i.issue]).filter(Boolean) as number[]);
  const seen = new Set<string>();
  const drafts = g.commits.map(draftLine).filter((i): i is Item => i !== null).map(i => settleRefs(i, prSet, issueSet))
    .filter(i => !(i.pr && covered.has(i.pr)) && !(i.issue && covered.has(i.issue)))
    .filter(i => { const key = i.text.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  return { entry: { version, date, ...(title ? { title } : {}), items: [...curated] }, drafts };
}

const link = (i: Item) => [i.issue ? `[#${i.issue}](https://github.com/${SOURCE_REPO}/issues/${i.issue})` : "", i.pr ? `[#${i.pr}](https://github.com/${SOURCE_REPO}/pull/${i.pr})` : ""].filter(Boolean).join(", ");
const line = (i: Item) => `- ${i.text}${link(i) ? ` (${link(i)})` : ""}`;

function byArea(items: readonly Item[]): string[] {
  const out: string[] = [];
  for (const area of AREA_ORDER) {
    const mine = items.filter(i => i.area === area);
    if (!mine.length) continue;
    out.push(`### ${AREA_LABEL[area]}`, "", ...mine.map(line), "");
  }
  return out;
}

/** the GitHub release body: T3 Code's short highlights and folded full list, Hermes' downloads table and per-install updating */
export function releaseBody(o: { entry: Entry; drafts: readonly Item[]; g: Gathered; since: string; apk?: { version: string } | null }): string {
  const { entry, drafts, g, since } = o, v = entry.version;
  const dl = (name: string) => `https://github.com/${DOWNLOADS_REPO}/releases/download/v${v}/${name}`;
  const stable = releaseAssets(v).filter(a => a.stable);
  const rows = stable.map(a => `| ${a.label}${a.kind === "android" && o.apk ? ` (${o.apk.version})` : ""} | [${a.name}](${dl(a.name)}) |`);
  const stats = [`${g.commits.length} changes`, g.prs.length ? `${g.prs.length} pull requests` : "", g.issues.length ? `${g.issues.length} issues closed` : ""].filter(Boolean).join(" · ");
  return [
    `**dusk bot ${v}**${entry.title ? `: ${entry.title}` : ""} · ${stats}`,
    "",
    "## What's new",
    "",
    ...(entry.items.length ? byArea(entry.items) : ["- Fixes and small improvements.", ""]),
    "## Downloads",
    "",
    "Every file is also at [dusk.bot/download](https://dusk.bot/download). Checksums are in SHA256SUMS; latest.json is the signed manifest the apps update from.",
    "",
    "| For | File |",
    "|---|---|",
    ...rows,
    `| Server, Docker | \`docker pull ${SERVER_IMAGE}:v${v}\` |`,
    "",
    "## Updating",
    "",
    "- **Mac, Windows and Linux apps** update themselves; Settings > Updates checks now.",
    "- **Android**: install the new DuskBot.apk over the old one; your pairing stays. **iPhone**: the App Store.",
    "- **Server installed with the app's one line** (systemd): it updates itself within about 15 minutes, once no bot is working. `duskbot update` shows what's new and starts it now.",
    `- **Server or CLI installed with npm**: \`duskbot update\`, or \`npm install -g ${dl(`duskbot-${v}.tgz`)}\`.`,
    "- **Docker**: `docker compose pull dusk && docker compose up -d`.",
    "- **dusk cloud**: kept up to date for you.",
    "",
    ...(drafts.length || g.prs.length || g.issues.length ? [
      "<details>",
      "<summary>Every change in this release</summary>",
      "",
      ...(drafts.length ? ["### Also in this release", "", ...byArea(drafts)] : []),
      ...(g.prs.length ? ["### Pull requests", "", ...g.prs.map(p => `- ${p.title} by @${p.author} in https://github.com/${SOURCE_REPO}/pull/${p.number}`), ""] : []),
      ...(g.issues.length ? ["### Issues closed", "", ...g.issues.map(i => `- #${i.number} ${i.title}`), ""] : []),
      "</details>",
      "",
    ] : []),
    `**Full changelog**: https://github.com/${SOURCE_REPO}/compare/${since}...v${v} · [all releases](https://dusk.bot/changelog)`,
    "",
  ].join("\n");
}

export function applyEntry(log: Changelog, entry: Entry): Changelog {
  return { v: 1, releases: [entry, ...log.releases.filter(r => r.version !== entry.version)] };
}

const git = (args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }).trim();

export function lastTag(to: string): string {
  return git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", `${to}^`]);
}

export function gatherCommits(since: string, to: string): Commit[] {
  const out = git(["log", "--no-merges", "--format=%x1e%H%x1f%s", "--name-only", `${since}..${to}`]);
  return out.split("\x1e").filter(Boolean).map(block => {
    const [head, ...files] = block.trim().split("\n");
    const [sha, subject] = head!.split("\x1f");
    return { sha: sha!, subject: subject ?? "", files: files.filter(Boolean) };
  });
}

/** true when `sha` is in `to` and not already in `since` (a PR merged into dev before the last release shipped in it) */
export function inRange(sha: string, since: string, to: string, isAncestor = (a: string, b: string) => { try { git(["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; } }): boolean {
  return isAncestor(sha, to) && !isAncestor(sha, since);
}

function gatherGithub(since: string, to: string, commits: readonly Commit[]): Pick<Gathered, "prs" | "issues"> {
  const gh = (args: string[]) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || "[]");
  // the window opens when the last release went out (its GitHub release), not at its commit, which can be days older
  let from = git(["log", "-1", "--format=%cI", since]);
  try { from = gh(["release", "view", since, "--repo", SOURCE_REPO, "--json", "publishedAt"]).publishedAt || from; } catch { /* no GitHub release for it */ }
  const day = (iso: string) => iso.slice(0, 10);
  const prs = (gh(["pr", "list", "--repo", SOURCE_REPO, "--state", "merged", "--search", `merged:>=${day(new Date(Date.parse(from) - 14 * 86_400_000).toISOString())}`, "--limit", "500", "--json", "number,title,author,mergeCommit"]) as { number: number; title: string; author: { login: string }; mergeCommit?: { oid: string } | null }[])
    .filter(p => p.mergeCommit?.oid && inRange(p.mergeCommit.oid, since, to))
    .map(p => ({ number: p.number, title: p.title, author: p.author.login })).sort((a, b) => a.number - b.number);
  const named = new Set(commits.flatMap(c => [...c.subject.matchAll(/#(\d+)/g)].map(m => Number(m[1]))));
  const issues = (gh(["issue", "list", "--repo", SOURCE_REPO, "--state", "closed", "--search", `closed:>=${day(from)} reason:completed`, "--limit", "300", "--json", "number,title,closedAt"]) as { number: number; title: string; closedAt: string }[])
    .filter(i => named.has(i.number) || i.closedAt >= from)
    .map(({ number, title }) => ({ number, title })).sort((a, b) => a.number - b.number);
  return { prs, issues };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    since: { type: "string" }, to: { type: "string" }, date: { type: "string" }, out: { type: "string" }, title: { type: "string" }, apply: { type: "boolean" }, offline: { type: "boolean" } } });
  const version = positionals[0];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("usage: release-notes.ts <x.y.z> [--since vX.Y.Z] [--to REF] [--date YYYY-MM-DD] [--title TEXT] [--out DIR] [--apply] [--offline]");
    process.exit(2);
  }
  const to = values.to ?? "HEAD", since = values.since ?? lastTag(to);
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  const commits = gatherCommits(since, to);
  let github: Pick<Gathered, "prs" | "issues"> = { prs: [], issues: [] };
  if (!values.offline) {
    try { github = gatherGithub(since, to, commits); } catch (error) { console.error(`GitHub lists skipped: ${(error as Error).message.split("\n")[0]}`); }
  }
  const unreleased = existsSync(UNRELEASED) ? JSON.parse(readFileSync(UNRELEASED, "utf8")) as { items?: Item[]; title?: string } : {};
  const log = existsSync(CHANGELOG) ? JSON.parse(readFileSync(CHANGELOG, "utf8")) as Changelog : null;
  const curated = curatedFor(version, unreleased, log);
  const g = { commits, ...github };
  const { entry, drafts } = buildEntry(version, date, curated.items, g, values.title ?? curated.title);
  let apk: { version: string } | null = null;
  try { apk = (JSON.parse(readFileSync(join(ROOT, "apps", "site", "public", "landing", "releases", "latest.json"), "utf8")) as { android?: { version: string } }).android ?? null; } catch { /* none yet */ }
  const body = releaseBody({ entry, drafts, g, since, apk });
  const out = values.out ?? join(ROOT, "release", "notes");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${version}.md`), body);
  writeFileSync(join(out, `${version}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  console.log(`dusk bot ${version} since ${since}: ${commits.length} commits, ${github.prs.length} PRs, ${github.issues.length} issues closed`);
  console.log(`  ${entry.items.length} curated lines, ${drafts.length} draft lines (Also in this release)`);
  console.log(`  ${join(out, `${version}.md`)}\n  ${join(out, `${version}.json`)}`);
  if (values.apply) {
    const log = existsSync(CHANGELOG) ? JSON.parse(readFileSync(CHANGELOG, "utf8")) as Changelog : { v: 1 as const, releases: [] };
    writeFileSync(CHANGELOG, `${JSON.stringify(applyEntry(log, entry), null, 2)}\n`);
    writeFileSync(UNRELEASED, `${JSON.stringify({ ...JSON.parse(readFileSync(UNRELEASED, "utf8")), items: [] }, null, 2)}\n`);
    console.log(`  applied to ${CHANGELOG}; ${UNRELEASED} emptied`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
