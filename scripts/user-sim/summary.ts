// summary.json and summary.md from a run's results.jsonl, and a diff of two runs:
//   node --experimental-strip-types scripts/user-sim/summary.ts <run-dir>                 (rewrite its summary)
//   node --experimental-strip-types scripts/user-sim/summary.ts <before> <after>   (what changed; a run folder, summary.json or baseline.json)
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Row {
  key: string; id: string; world: string; tags: string[]; success: boolean; pass: boolean; crashed?: string;
  checks: Array<{ label: string; ok: boolean; recall?: boolean }>;
  verdict: { score: number; done: boolean; quality?: number; tone?: number; needlessQuestions?: number; patterns: string[]; why: string };
  metrics?: { personTurns: number; steps: number; failedTurns: number; ttftMs: number | null; turnLatencyMs: number | null; tokensIn: number; tokensOut: number; costUsd: number; costEstimated: boolean; recall: { hit: number; of: number } | null; wallMs: number;
    workTurns?: number; earlyOnWork?: number; quickTurns?: number; earlyOnQuick?: number; beats?: Record<string, number> };
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const quantile = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))]! : null; };

export interface RunInfo { label?: string; repoCommit?: string; codeCommit?: string; model?: string }

export function summarize(rows: Row[], info: RunInfo = {}) {
  const m = rows.flatMap((r) => (r.metrics ? [r.metrics] : []));
  const recall = m.reduce((t, x) => ({ hit: t.hit + (x.recall?.hit ?? 0), of: t.of + (x.recall?.of ?? 0) }), { hit: 0, of: 0 });
  const patterns: Record<string, number> = {};
  for (const r of rows) for (const p of r.verdict.patterns) patterns[p] = (patterns[p] ?? 0) + 1;
  const byTag: Record<string, { n: number; pass: number; success: number }> = {};
  for (const r of rows) for (const t of r.tags) { const b = (byTag[t] ??= { n: 0, pass: 0, success: 0 }); b.n++; if (r.pass) b.pass++; if (r.success) b.success++; }
  const ttft = m.map((x) => x.ttftMs).filter((x): x is number => x !== null);
  const lat = m.map((x) => x.turnLatencyMs).filter((x): x is number => x !== null);
  return {
    label: info.label ?? null,
    repoCommit: info.repoCommit ?? null,
    codeCommit: info.codeCommit ?? null,
    model: info.model ?? null,
    at: new Date().toISOString(),
    scenarios: rows.length,
    passRate: pct(rows.filter((r) => r.pass).length, rows.length),
    taskSuccessRate: pct(rows.filter((r) => r.success).length, rows.length),
    judgeDoneRate: pct(rows.filter((r) => r.verdict.done).length, rows.length),
    checksPassed: `${rows.reduce((t, r) => t + r.checks.filter((c) => c.ok).length, 0)}/${rows.reduce((t, r) => t + r.checks.length, 0)}`,
    judgeScore: mean(rows.map((r) => r.verdict.score)),
    quality: mean(rows.map((r) => r.verdict.quality ?? 0).filter(Boolean)),
    tone: mean(rows.map((r) => r.verdict.tone ?? 0).filter(Boolean)),
    needlessQuestions: rows.reduce((t, r) => t + (r.verdict.needlessQuestions ?? 0), 0),
    memoryRecall: recall.of ? `${recall.hit}/${recall.of} (${pct(recall.hit, recall.of)}%)` : null,
    medianTtftMs: quantile(ttft, 0.5), p90TtftMs: quantile(ttft, 0.9),
    medianTurnMs: quantile(lat, 0.5), p90TurnMs: quantile(lat, 0.9),
    personTurns: m.reduce((t, x) => t + x.personTurns, 0),
    // a quick first line or progress note before the result, on turns past 15 s; and on quicker turns, where none should come
    firstMessageOnWork: `${m.reduce((t, x) => t + (x.earlyOnWork ?? 0), 0)}/${m.reduce((t, x) => t + (x.workTurns ?? 0), 0)}`,
    firstMessageOnQuick: `${m.reduce((t, x) => t + (x.earlyOnQuick ?? 0), 0)}/${m.reduce((t, x) => t + (x.quickTurns ?? 0), 0)}`,
    beats: m.reduce<Record<string, number>>((t, x) => { for (const [k, v] of Object.entries(x.beats ?? {})) t[k] = (t[k] ?? 0) + v; return t; }, {}),
    toolSteps: m.reduce((t, x) => t + x.steps, 0),
    failedTurns: m.reduce((t, x) => t + x.failedTurns, 0),
    tokensIn: m.reduce((t, x) => t + x.tokensIn, 0), tokensOut: m.reduce((t, x) => t + x.tokensOut, 0),
    costUsd: Math.round(m.reduce((t, x) => t + x.costUsd, 0) * 100) / 100, costEstimated: m.some((x) => x.costEstimated),
    crashed: rows.filter((r) => r.crashed).map((r) => r.key),
    patterns: Object.fromEntries(Object.entries(patterns).sort((a, b) => b[1] - a[1])),
    byTag: Object.fromEntries(Object.entries(byTag).sort()),
    rows: rows.map((r) => ({
      key: r.key, id: r.id, category: r.tags.find((t) => t !== "x-usage") ?? r.tags[0], tags: r.tags, world: r.world,
      pass: r.pass, success: r.success, done: r.verdict.done, score: r.verdict.score, quality: r.verdict.quality ?? null, tone: r.verdict.tone ?? null,
      needlessQuestions: r.verdict.needlessQuestions ?? 0, checks: `${r.checks.filter((c) => c.ok).length}/${r.checks.length}`,
      failed: r.checks.filter((c) => !c.ok).map((c) => c.label), patterns: r.verdict.patterns, recall: r.metrics?.recall ?? null,
      turns: r.metrics?.personTurns ?? 0, steps: r.metrics?.steps ?? 0, failedTurns: r.metrics?.failedTurns ?? 0,
      ttftMs: r.metrics?.ttftMs ?? null, turnMs: r.metrics?.turnLatencyMs ?? null, wallMs: r.metrics?.wallMs ?? null,
      tokensIn: r.metrics?.tokensIn ?? 0, tokensOut: r.metrics?.tokensOut ?? 0, tokens: (r.metrics?.tokensIn ?? 0) + (r.metrics?.tokensOut ?? 0),
      costUsd: r.metrics?.costUsd ?? 0, crashed: r.crashed ?? null, why: r.verdict.why,
    })).sort((a, b) => a.key.localeCompare(b.key)),
  };
}
export type Summary = ReturnType<typeof summarize>;

const s = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(1)}s`);

export function markdown(x: Summary): string {
  return [
    `# user-sim results${x.label ? `: ${x.label}` : ""}`,
    "",
    `Code ${x.codeCommit ?? "?"} (checkout ${x.repoCommit ?? "?"}), bot ${x.model ?? "?"}.`,
    "",
    `${x.scenarios} scenarios. Pass ${x.passRate}% (checks all green, goal done, judge >= 4). Task success ${x.taskSuccessRate}% (checks). Judge done ${x.judgeDoneRate}%.`,
    `Checks ${x.checksPassed}. Judge ${x.judgeScore}/5 (quality ${x.quality}, tone ${x.tone}). Needless questions ${x.needlessQuestions}. Memory recall ${x.memoryRecall ?? "-"}.`,
    `TTFT median ${s(x.medianTtftMs)} (p90 ${s(x.p90TtftMs)}). Turn median ${s(x.medianTurnMs)} (p90 ${s(x.p90TurnMs)}). ${x.personTurns} person turns, ${x.toolSteps} tool steps, ${x.failedTurns} failed turns.`,
    `Tokens ${x.tokensIn} in / ${x.tokensOut} out, ${x.costEstimated ? "est. " : ""}$${x.costUsd}.${x.crashed.length ? ` Crashed: ${x.crashed.join(", ")}.` : ""}`,
    "",
    "## Failure patterns (scenarios showing each)",
    "",
    ...Object.entries(x.patterns).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## By tag",
    "",
    "| tag | n | pass | success |", "|---|---|---|---|",
    ...Object.entries(x.byTag).map(([t, b]) => `| ${t} | ${b.n} | ${b.pass} | ${b.success} |`),
    "",
    "## Scenarios",
    "",
    "| scenario | pass | score | checks | turns | steps | ttft | turn | tokens | patterns |", "|---|---|---|---|---|---|---|---|---|---|",
    ...x.rows.map((r) => `| ${r.key} | ${r.pass ? "yes" : "no"} | ${r.score} | ${r.checks} | ${r.turns} | ${r.steps} | ${s(r.ttftMs)} | ${s(r.turnMs)} | ${r.tokens} | ${r.patterns.join(", ")} |`),
    "",
  ].join("\n");
}

export function writeSummary(dir: string, info: RunInfo = {}): Summary {
  const previous = existsSync(join(dir, "summary.json")) ? JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as Partial<Summary> : {};
  info = { label: previous.label ?? undefined, repoCommit: previous.repoCommit ?? undefined, codeCommit: previous.codeCommit ?? undefined, model: previous.model ?? undefined, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v)) };
  const rows = readFileSync(join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
  const latest = new Map(rows.map((r) => [r.key, r]));
  const summary = summarize([...latest.values()], info);
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
  writeFileSync(join(dir, "summary.md"), markdown(summary));
  return summary;
}

/** A run folder, or a summary.json / baseline.json file. */
export function readSummary(path: string): Summary {
  return JSON.parse(readFileSync(statSync(path).isDirectory() ? join(path, "summary.json") : path, "utf8")) as Summary;
}

export function diff(a: Summary, b: Summary): string {
  const keys = ["passRate", "taskSuccessRate", "judgeDoneRate", "judgeScore", "quality", "tone", "needlessQuestions", "memoryRecall", "medianTtftMs", "medianTurnMs", "toolSteps", "failedTurns", "tokensIn", "tokensOut", "costUsd"] as const;
  const rowsA = new Map(a.rows.map((r) => [r.key, r]));
  const flips = b.rows.filter((r) => rowsA.has(r.key) && rowsA.get(r.key)!.pass !== r.pass).map((r) => `- ${r.key}: ${rowsA.get(r.key)!.pass ? "pass -> fail" : "fail -> pass"} (score ${rowsA.get(r.key)!.score} -> ${r.score})`);
  const pats = [...new Set([...Object.keys(a.patterns), ...Object.keys(b.patterns)])].map((p) => `- ${p}: ${a.patterns[p] ?? 0} -> ${b.patterns[p] ?? 0}`);
  const commits = `before ${a.codeCommit ?? "?"} (${a.label ?? "unlabelled"}), after ${b.codeCommit ?? "?"} (${b.label ?? "unlabelled"})`;
  return [commits, "", "| metric | before | after |", "|---|---|---|", ...keys.map((k) => `| ${k} | ${a[k] ?? "-"} | ${b[k] ?? "-"} |`), "", "Flips:", ...(flips.length ? flips : ["- none"]), "", "Patterns:", ...pats, ""].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [one, two] = process.argv.slice(2);
  if (!one) throw new Error("usage: summary.ts <run-dir> [<other-run-dir>]");
  if (!two) console.log(markdown(writeSummary(one)));
  else console.log(diff(readSummary(one), readSummary(two)));
}
