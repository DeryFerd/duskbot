#!/usr/bin/env node
// A stand-in for the GitHub CLI over the same state file as connectors.mjs (APP_STATE), for a person who has `gh` signed
// in on their computer and no GitHub connection in dusk bot. Covers what a bot reaches for: auth status, repo list,
// pr list/view/checks/comment/diff, issue list/view/create/comment/close, and `api` for a few REST paths. Every call is
// logged as app "gh" so a check can see the bot used the CLI. Standard library only.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const statePath = process.env.APP_STATE;
const args = process.argv.slice(2);
const out = (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
const fail = (text, code = 1) => { process.stderr.write(`${text}\n`); process.exit(code); };
if (!statePath) fail("gh: not configured", 4);
const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (state) => { const tmp = `${statePath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state, null, 1)); renameSync(tmp, statePath); };
const now = () => new Date().toISOString();

const flags = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    if (v !== undefined) flags[k] = v;
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) flags[k] = args[++i];
    else flags[k] = true;
  } else if (/^-[A-Za-z]$/.test(a)) {
    const k = { R: "repo", b: "body", t: "title", s: "state", L: "limit", q: "jq", l: "label", F: "field", f: "field", X: "method" }[a[1]] ?? a[1];
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) flags[k] = args[++i];
    else flags[k] = true;
  } else rest.push(a);
}

const state = load();
const me = state.profile?.github ?? "me";
(state.log ??= []).push({ at: now(), app: "gh", action: rest.slice(0, 2).join(" ") || "gh", args: args.join(" ").slice(0, 200) });
save(state);
const repos = state.github?.repos ?? [];
const findRepo = (name) => {
  const want = name ?? repos[0]?.name;
  const r = repos.find((one) => one.name === want || one.name.split("/")[1] === want);
  if (!r) fail(`GraphQL: Could not resolve to a Repository with the name '${want}'. (repository)`);
  return r;
};
const json = (value) => {
  if (!flags.json) return false;
  const fields = String(flags.json).split(",").filter(Boolean);
  const pick = (row) => (fields.length && flags.json !== true ? Object.fromEntries(fields.map((f) => [f, row[f]])) : row);
  out(JSON.stringify(Array.isArray(value) ? value.map(pick) : pick(value), null, 2));
  return true;
};
const shape = (item, kind) => ({
  number: item.number, title: item.title, state: String(item.state ?? "open").toUpperCase(), body: item.body ?? "",
  author: { login: item.author ?? me }, labels: (item.labels ?? []).map((name) => ({ name })),
  assignees: item.assignee ? [{ login: item.assignee }] : [], createdAt: item.created, url: `https://github.com/REPO/${kind}/${item.number}`,
  comments: (item.comments ?? []).map((c) => ({ author: { login: c.author }, body: c.body, createdAt: c.at })),
  ...(kind === "pull" ? { headRefName: item.branch ?? `pr-${item.number}`, isDraft: Boolean(item.draft), reviewRequests: (item.reviewers ?? []).map((login) => ({ login })), statusCheckRollup: (item.checks ?? []).map((c) => ({ name: c.name, conclusion: String(c.status).toUpperCase(), status: "COMPLETED" })), files: (item.files ?? []).map((path) => ({ path })) } : {}),
});
const table = (rows) => out(rows.map((r) => r.join("\t")).join("\n") || "");
const [cmd, sub, target] = rest;
const num = (v) => Number(String(v ?? "").replace(/^#/, "").split("/").pop());

if (cmd === "--version" || flags.version) { out("gh version 2.62.0 (2026-10-02)"); process.exit(0); }
if (cmd === "auth" && sub === "status") { out(`github.com\n  ✓ Logged in to github.com account ${me} (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'`); process.exit(0); }
if (cmd === "repo" && sub === "list") {
  if (json(repos.map((r) => ({ name: r.name.split("/")[1], nameWithOwner: r.name, description: r.description, defaultBranchRef: { name: r.default_branch } })))) process.exit(0);
  table(repos.map((r) => [r.name, r.description ?? "", "private"]));
  process.exit(0);
}
if (cmd === "repo" && sub === "view") {
  const r = findRepo(target ?? flags.repo);
  if (json({ name: r.name.split("/")[1], nameWithOwner: r.name, description: r.description })) process.exit(0);
  out(`${r.name}\n${r.description ?? ""}`);
  process.exit(0);
}
if (cmd === "pr" || cmd === "issue") {
  const kind = cmd === "pr" ? "pull" : "issue";
  const r = findRepo(flags.repo);
  const list = cmd === "pr" ? r.pulls : r.issues;
  if (sub === "list" || sub === undefined) {
    const st = String(flags.state ?? "open").toLowerCase();
    let rows = list.filter((i) => st === "all" || String(i.state ?? "open").toLowerCase() === st);
    if (flags.label) rows = rows.filter((i) => (i.labels ?? []).includes(flags.label));
    if (flags.author) rows = rows.filter((i) => i.author === (flags.author === "@me" ? me : flags.author));
    if (flags.assignee) rows = rows.filter((i) => i.assignee === (flags.assignee === "@me" ? me : flags.assignee));
    if (json(rows.map((i) => shape(i, kind)))) process.exit(0);
    if (!rows.length) { out(`no open ${cmd === "pr" ? "pull requests" : "issues"} in ${r.name}`); process.exit(0); }
    out(`\nShowing ${rows.length} of ${rows.length} open ${cmd === "pr" ? "pull requests" : "issues"} in ${r.name}\n`);
    table(rows.map((i) => [`#${i.number}`, i.title, cmd === "pr" ? i.branch ?? `pr-${i.number}` : (i.labels ?? []).join(", "), i.created ?? ""]));
    process.exit(0);
  }
  const n = num(target);
  const item = list.find((i) => i.number === n) ?? (cmd === "issue" ? r.pulls.find((i) => i.number === n) : undefined);
  if (sub === "create") {
    const number = Math.max(0, ...r.issues.map((i) => i.number), ...r.pulls.map((p) => p.number)) + 1;
    r.issues.push({ number, title: flags.title ?? "", body: flags.body ?? "", labels: flags.label ? [flags.label] : [], state: "open", author: me, created: now(), comments: [], by_assistant: true });
    state.log.push({ at: now(), app: "gh", action: "gh_issue", repo: r.name, number, title: flags.title });
    save(state);
    out(`https://github.com/${r.name}/issues/${number}`);
    process.exit(0);
  }
  if (!item) fail(`GraphQL: Could not resolve to a ${cmd === "pr" ? "PullRequest" : "Issue"} with the number of ${target}.`);
  if (sub === "view") {
    if (json(shape(item, kind))) process.exit(0);
    out(`${item.title} #${item.number}\n${String(item.state ?? "open")} • ${item.author} ${cmd === "pr" ? `wants to merge ${item.branch ?? `pr-${item.number}`} into ${r.default_branch}` : ""}\n${(item.labels ?? []).length ? `Labels: ${item.labels.join(", ")}\n` : ""}\n  ${String(item.body ?? "").replaceAll("\n", "\n  ")}\n`);
    if (flags.comments) for (const c of item.comments ?? []) out(`${c.author} • ${c.at}\n  ${c.body}\n`);
    else if ((item.comments ?? []).length) out(`———————— Not showing ${item.comments.length} comments ————————\nUse --comments to view the full conversation`);
    out(`View this ${cmd === "pr" ? "pull request" : "issue"} on GitHub: https://github.com/${r.name}/${kind}/${item.number}`);
    process.exit(0);
  }
  if (sub === "checks" && cmd === "pr") {
    const checks = item.checks ?? [];
    if (json(checks.map((c) => ({ name: c.name, state: String(c.status).toUpperCase(), description: c.summary ?? "" })))) process.exit(0);
    const failing = checks.filter((c) => c.status === "failure").length;
    out(`${failing ? "Some checks were not successful" : "All checks were successful"}\n${failing} failing, ${checks.length - failing} successful\n`);
    table(checks.map((c) => [c.status === "failure" ? "X" : "✓", c.name, c.summary ?? ""]));
    process.exit(failing ? 8 : 0);
  }
  if (sub === "diff" && cmd === "pr") { out((item.files ?? []).map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ changed @@`).join("\n") || item.body || ""); process.exit(0); }
  if (sub === "comment") {
    const body = flags.body;
    if (!body || body === true) fail("must provide --body when not running interactively");
    (item.comments ??= []).push({ author: me, body, at: now(), by_assistant: true });
    state.log.push({ at: now(), app: "gh", action: "gh_comment", repo: r.name, number: item.number });
    save(state);
    out(`https://github.com/${r.name}/${kind}/${item.number}#issuecomment-${Date.now()}`);
    process.exit(0);
  }
  if (sub === "close" || sub === "reopen") {
    item.state = sub === "close" ? "closed" : "open";
    state.log.push({ at: now(), app: "gh", action: `gh_${sub}`, repo: r.name, number: item.number });
    save(state);
    out(`✓ ${sub === "close" ? "Closed" : "Reopened"} ${cmd === "pr" ? "pull request" : "issue"} ${r.name}#${item.number} (${item.title})`);
    process.exit(0);
  }
}
if (cmd === "api") {
  const m = /^\/?repos\/([^/]+\/[^/]+)\/(pulls|issues)(?:\/(\d+))?(?:\/(comments))?/.exec(sub ?? "");
  if (m) {
    const r = findRepo(m[1]);
    const list = m[2] === "pulls" ? r.pulls : [...r.issues, ...r.pulls];
    const item = m[3] ? list.find((i) => i.number === Number(m[3])) : undefined;
    if (m[3] && !item) fail('{"message":"Not Found","status":"404"}');
    if (m[4]) { out(JSON.stringify(item.comments ?? [], null, 2)); process.exit(0); }
    out(JSON.stringify(item ?? list, null, 2));
    process.exit(0);
  }
  if (sub === "user" || sub === "/user") { out(JSON.stringify({ login: me, name: state.profile?.name }, null, 2)); process.exit(0); }
  fail('{"message":"Not Found","status":"404"}');
}
fail(`unknown command "${rest.join(" ")}" for "gh"\n\nUsage:  gh <command> <subcommand> [flags]`);
