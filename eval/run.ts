/**
 * npm run eval (Q-01): run labelled policies through the real pipeline and print
 * per-category precision/recall, verdict accuracy, the share of model findings dropped
 * by quote verification, and median latency. Writes eval/results.md.
 *
 * Two sets, reported separately:
 *  - fixtures: every site in fixtures/golden.json (fictional stores, built to plant clauses)
 *  - real-world: eval/real/labels.json + eval/real/*.txt when present (git-ignored, local only)
 *
 * The LLM provider comes from server/.env (LLM_PROVIDER=mock by default). Each case runs
 * against a fresh in-memory store, so nothing is served from cache.
 *
 * Compare mode (V-03): `npm run eval -- --compare` or EVAL_COMPARE=1 runs every case twice,
 * rules only and rules + the configured model, and prints both side by side with the
 * per-case verdict differences. Without a real provider and key, the model column is skipped.
 *
 * Repeats (direction v3): `--runs N` (or EVAL_RUNS=N) runs every model case N times and reports the
 * mean and spread of verdict accuracy, precision and recall, plus p50/p90/p95 latency and how many
 * calls fell back to rules (timeouts counted separately). The mock is deterministic, so it runs once.
 *
 * Severity: where a label has `expectedSeverity`, each matched category's severity is scored
 * (agreement, plus how often we were harsher or milder). Otherwise the severity distribution is shown.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY_ORDER, GoldenSchema, stripPageUrl } from "@xcavate/shared";
import type { AnalyzeRequest, Category, PolicyKind, Report, Severity, Verdict } from "@xcavate/shared";
import { z } from "zod";
import { FIXTURES_DIR } from "../fixtures/load.js";
import { buildRequest, caseById } from "../server/scripts/fixtureRequests.js";
import { loadConfig } from "../server/src/config.js";
import { loadEnv } from "../server/src/env.js";
import { MockLlm, createLlm } from "../server/src/llm/index.js";
import type { LlmClient } from "../server/src/llm/index.js";
import { setSilent } from "../server/src/log.js";
import { runAnalysis } from "../server/src/pipeline/run.js";
import { openStore } from "../server/src/store/index.js";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const REAL_DIR = process.env.EVAL_REAL_DIR || join(EVAL_DIR, "real");

setSilent(true);
loadEnv();
const config = loadConfig();
const llm = createLlm(config);
const COMPARE = process.argv.includes("--compare") || /^(1|true|yes)$/i.test(process.env.EVAL_COMPARE ?? "");
function runsArg(): number {
  const i = process.argv.indexOf("--runs");
  const raw = i >= 0 ? process.argv[i + 1] : process.env.EVAL_RUNS;
  const n = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : 1;
}
const RUNS = runsArg();

/** "anthropic, model claude-..." or "mock (offline: rules engine only, no model)". */
function providerLabel(client: LlmClient): string {
  return client.provider === "mock" ? "mock (offline: rules engine only, no model)" : `${client.provider}, model ${config.llmModel}`;
}

/** Why the model column cannot run, or undefined when it can. */
function modelUnavailable(): string | undefined {
  if (config.llmProvider === "mock") return "LLM_PROVIDER is mock";
  if (!config.llmApiKey) return `LLM_PROVIDER is ${config.llmProvider} but LLM_API_KEY is not set`;
  return undefined;
}

interface Case {
  id: string;
  request: AnalyzeRequest;
  expected: Category[];
  forbidden?: Category[];
  verdict: Verdict;
  /** Expected severity per category, when the label states one. */
  severity?: Partial<Record<Category, Severity>>;
}

interface Outcome {
  c: Case;
  report: Report;
  ms: number;
}

// ---------- case loading ----------

function fixtureCases(): Case[] {
  const golden = GoldenSchema.parse(JSON.parse(readFileSync(join(FIXTURES_DIR, "golden.json"), "utf8")));
  return golden.sites.map((s) => ({
    id: s.id,
    request: buildRequest(caseById(s.id)),
    expected: s.categories,
    forbidden: s.forbidden,
    verdict: s.verdict,
  }));
}

const RealItem = z.object({
  id: z.string(),
  site: z.string().optional(),
  url: z.string(),
  kind: z.string().optional(),
  file: z.string(),
  expectedCategories: z.array(z.string()),
  expectedVerdict: z.string(),
  expectedSeverity: z.record(z.string()).optional(),
  evidence: z.unknown().optional(),
});

const SEVERITIES: Severity[] = ["high", "medium", "low"];

const KINDS: PolicyKind[] = ["subscription", "refund", "terms", "privacy", "other"];

function realCases(): { cases: Case[]; skipped: string[] } | undefined {
  const labelsPath = join(REAL_DIR, "labels.json");
  if (!existsSync(labelsPath)) return undefined;
  const raw = JSON.parse(readFileSync(labelsPath, "utf8"));
  const items = z.array(RealItem).parse(Array.isArray(raw) ? raw : raw.items);
  const cases: Case[] = [];
  const skipped: string[] = [];
  for (const it of items) {
    const path = isAbsolute(it.file) ? it.file : join(REAL_DIR, it.file.replace(/^eval\/real\//, ""));
    const cats = it.expectedCategories.filter((c): c is Category => (CATEGORY_ORDER as readonly string[]).includes(c));
    const verdict = (["red", "yellow", "green", "partial", "unknown"] as const).find((v) => v === it.expectedVerdict);
    if (!existsSync(path) || !verdict || cats.length !== it.expectedCategories.length) {
      skipped.push(it.id + (!existsSync(path) ? " (file missing)" : " (bad label)"));
      continue;
    }
    const text = readFileSync(path, "utf8").slice(0, 200_000);
    const kind = KINDS.find((k) => k === it.kind) ?? "terms";
    let pageUrl: string;
    try {
      pageUrl = stripPageUrl(it.url);
    } catch {
      skipped.push(it.id + " (bad url)");
      continue;
    }
    cases.push({
      id: it.id,
      request: { pageUrl, pageType: "none", linksFound: 1, policies: [{ url: pageUrl, kind, text }] },
      expected: cats,
      verdict,
      severity: Object.fromEntries(
        Object.entries(it.expectedSeverity ?? {}).filter(
          (e): e is [Category, Severity] => (CATEGORY_ORDER as readonly string[]).includes(e[0]) && (SEVERITIES as string[]).includes(e[1]),
        ),
      ),
    });
  }
  return { cases, skipped };
}

// ---------- running and scoring ----------

async function run(cases: Case[], client: LlmClient): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const c of cases) {
    const store = openStore(":memory:", "memory");
    const t0 = performance.now();
    const report = await runAnalysis(c.request, { store, llm: client });
    out.push({ c, report, ms: performance.now() - t0 });
    store.close();
  }
  return out;
}

interface Metrics {
  n: number;
  perCategory: { category: Category; tp: number; fp: number; fn: number; sevAgree: number; sevHarsher: number; sevMilder: number; dist: Record<Severity, number> }[];
  micro: { tp: number; fp: number; fn: number };
  /** Severity scored on matched categories that have a labelled severity. */
  sev: { scored: number; agree: number; harsher: number; milder: number };
  verdictCorrect: number;
  dropped: number;
  modelKept: number;
  medianMs: number;
  usedLlm: number;
  forbiddenHits: string[];
}

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

function score(outcomes: Outcome[]): Metrics {
  const perCategory = CATEGORY_ORDER.map((category) => ({
    category,
    tp: 0,
    fp: 0,
    fn: 0,
    sevAgree: 0,
    sevHarsher: 0,
    sevMilder: 0,
    dist: { high: 0, medium: 0, low: 0 } as Record<Severity, number>,
  }));
  const sev = { scored: 0, agree: 0, harsher: 0, milder: 0 };
  const forbiddenHits: string[] = [];
  let verdictCorrect = 0;
  let dropped = 0;
  let modelKept = 0;
  let usedLlm = 0;
  for (const { c, report } of outcomes) {
    const got = new Set(report.flags.map((f) => f.category));
    const want = new Set(c.expected);
    for (const row of perCategory) {
      if (got.has(row.category) && want.has(row.category)) row.tp++;
      else if (got.has(row.category)) row.fp++;
      else if (want.has(row.category)) row.fn++;
      const flag = report.flags.find((f) => f.category === row.category);
      if (flag) row.dist[flag.severity]++;
      const exp = c.severity?.[row.category];
      if (flag && exp && want.has(row.category)) {
        sev.scored++;
        if (flag.severity === exp) (row.sevAgree++, sev.agree++);
        else if (RANK[flag.severity] > RANK[exp]) (row.sevHarsher++, sev.harsher++);
        else (row.sevMilder++, sev.milder++);
      }
    }
    for (const f of c.forbidden ?? []) if (got.has(f)) forbiddenHits.push(c.id + ":" + f);
    if (report.verdict === c.verdict) verdictCorrect++;
    dropped += report.stats.droppedUnverified;
    modelKept += report.flags.filter((f) => f.source !== "rules").length;
    if (report.stats.usedLlm) usedLlm++;
  }
  const ms = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const mid = Math.floor(ms.length / 2);
  const medianMs = ms.length === 0 ? 0 : ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2;
  const micro = perCategory.reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn }), { tp: 0, fp: 0, fn: 0 });
  return { n: outcomes.length, perCategory, micro, sev, verdictCorrect, dropped, modelKept, medianMs, usedLlm, forbiddenHits };
}

/** Nearest-rank percentile of a list of numbers. */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const sevLine = (m: Metrics) =>
  m.sev.scored === 0
    ? "Severity: no labelled severities."
    : `Severity agreement on matched categories: ${m.sev.agree}/${m.sev.scored} (${pct(m.sev.agree, m.sev.scored)}); harsher ${m.sev.harsher}, milder ${m.sev.milder}.`;
const distText = (d: Record<Severity, number>) => SEVERITIES.filter((s) => d[s]).map((s) => s[0].toUpperCase() + d[s]).join(" ") || "-";

const pct = (num: number, den: number) => (den === 0 ? "n/a" : ((100 * num) / den).toFixed(0) + "%");

function tables(title: string, outcomes: Outcome[], m: Metrics, note: string): string {
  const rows = m.perCategory.filter((r) => r.tp + r.fp + r.fn > 0);
  const lines = [
    `## ${title}`,
    "",
    note,
    "",
    `Sample size: **${m.n}** cases. Verdict accuracy: **${m.verdictCorrect}/${m.n} (${pct(m.verdictCorrect, m.n)})**. ` +
      `Micro precision ${pct(m.micro.tp, m.micro.tp + m.micro.fp)}, recall ${pct(m.micro.tp, m.micro.tp + m.micro.fn)}. ` +
      `Median latency ${m.medianMs.toFixed(0)} ms. LLM answered in ${m.usedLlm}/${m.n} cases.`,
    "",
    m.usedLlm === 0
      ? "Dropped by quote verification: n/a (no model ran)."
      : `Dropped by quote verification: ${m.dropped} of ${m.dropped + m.modelKept} model findings (${pct(m.dropped, m.dropped + m.modelKept)}).`,
    "",
    sevLine(m),
    "",
    "| Category | TP | FP | FN | Precision | Recall | Severity agree / harsher / milder | Severity shown (H/M/L) |",
    "|---|---:|---:|---:|---:|---:|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.category} | ${r.tp} | ${r.fp} | ${r.fn} | ${pct(r.tp, r.tp + r.fp)} | ${pct(r.tp, r.tp + r.fn)} | ${r.sevAgree} / ${r.sevHarsher} / ${r.sevMilder} | ${distText(r.dist)} |`,
    ),
    "",
    "| Case | Expected verdict | Got | Expected categories | Got flags (category:severity) | ms |",
    "|---|---|---|---|---|---:|",
    ...outcomes.map(
      (o) =>
        `| ${o.c.id} | ${o.c.verdict} | ${o.report.verdict}${o.report.verdict === o.c.verdict ? "" : " (miss)"} | ${o.c.expected.join(", ") || "none"} | ${why(
          o.report,
        )} | ${o.ms.toFixed(0)} |`,
    ),
    "",
  ];
  if (m.forbiddenHits.length) lines.push(`Forbidden categories that fired: ${m.forbiddenHits.join(", ")}`, "");
  return lines.join("\n");
}

function consoleSummary(title: string, m: Metrics): string {
  const rows = m.perCategory.filter((r) => r.tp + r.fp + r.fn > 0);
  return [
    `${title}: n=${m.n}, verdict ${m.verdictCorrect}/${m.n}, precision ${pct(m.micro.tp, m.micro.tp + m.micro.fp)}, recall ${pct(m.micro.tp, m.micro.tp + m.micro.fn)}, dropped ${m.usedLlm === 0 ? "n/a (no model)" : `${m.dropped}/${m.dropped + m.modelKept}`}, median ${m.medianMs.toFixed(0)} ms`,
    "  " + sevLine(m),
    "  category               TP  FP  FN  prec  recall  sev a/h/m  shown",
    ...rows.map(
      (r) =>
        "  " +
        r.category.padEnd(22) +
        String(r.tp).padStart(3) +
        String(r.fp).padStart(4) +
        String(r.fn).padStart(4) +
        pct(r.tp, r.tp + r.fp).padStart(6) +
        pct(r.tp, r.tp + r.fn).padStart(8) +
        `  ${r.sevAgree}/${r.sevHarsher}/${r.sevMilder}`.padEnd(11) +
        distText(r.dist),
    ),
  ].join("\n");
}

// ---------- main ----------

/** "no_refund:high, auto_renewal:low": the flags behind a verdict. */
const why = (r: Report) => r.flags.map((f) => `${f.category}:${f.severity}`).join(", ") || "none";

interface SetResult {
  /** The first run (tables and per-case diffs). */
  outcomes: Outcome[];
  metrics: Metrics;
  /** Every run, when repeated (`--runs N`). */
  runs: { outcomes: Outcome[]; metrics: Metrics }[];
}

async function evaluate(cases: Case[], client: LlmClient, runs = 1): Promise<SetResult> {
  const n = client.provider === "mock" ? 1 : runs;
  const all: { outcomes: Outcome[]; metrics: Metrics }[] = [];
  for (let i = 0; i < n; i++) {
    const outcomes = cases.length ? await run(cases, client) : [];
    all.push({ outcomes, metrics: score(outcomes) });
  }
  return { outcomes: all[0].outcomes, metrics: all[0].metrics, runs: all };
}

/** "mean 82% (min 78%, max 85%, sd 3.1)" over runs. */
function spread(xs: number[]): string {
  if (xs.length === 0) return "n/a";
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length === 1) return `${mean.toFixed(0)}%`;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  return `mean ${mean.toFixed(0)}% (min ${Math.min(...xs).toFixed(0)}%, max ${Math.max(...xs).toFixed(0)}%, sd ${sd.toFixed(1)})`;
}

const ratio = (num: number, den: number) => (den === 0 ? 0 : (100 * num) / den);

/** Repeat statistics: spread of the headline metrics, latency percentiles, fallbacks and timeouts. */
function repeatStats(title: string, r: SetResult, client: LlmClient): string {
  const outs = r.runs.flatMap((x) => x.outcomes);
  const ms = outs.map((o) => o.ms);
  const model = client.provider !== "mock";
  const fellBack = model ? outs.filter((o) => !o.report.stats.usedLlm).length : 0;
  const timeouts = model ? outs.filter((o) => !o.report.stats.usedLlm && o.ms >= config.llmTimeoutMs * 0.95).length : 0;
  return [
    `${title}: ${r.runs.length} run(s) x ${r.metrics.n} cases`,
    `  verdict accuracy ${spread(r.runs.map((x) => ratio(x.metrics.verdictCorrect, x.metrics.n)))}`,
    `  precision ${spread(r.runs.map((x) => ratio(x.metrics.micro.tp, x.metrics.micro.tp + x.metrics.micro.fp)))}`,
    `  recall ${spread(r.runs.map((x) => ratio(x.metrics.micro.tp, x.metrics.micro.tp + x.metrics.micro.fn)))}`,
    `  severity agreement ${spread(r.runs.filter((x) => x.metrics.sev.scored > 0).map((x) => ratio(x.metrics.sev.agree, x.metrics.sev.scored)))}`,
    `  dropped by verification ${spread(r.runs.filter((x) => x.metrics.dropped + x.metrics.modelKept > 0).map((x) => ratio(x.metrics.dropped, x.metrics.dropped + x.metrics.modelKept)))}`,
    `  latency p50 ${percentile(ms, 50).toFixed(0)} ms, p90 ${percentile(ms, 90).toFixed(0)} ms, p95 ${percentile(ms, 95).toFixed(0)} ms`,
    model ? `  fell back to rules ${fellBack}/${outs.length} (of which timeouts ${timeouts}, timeout ${config.llmTimeoutMs} ms)` : "  fell back to rules: n/a (no model)",
  ].join("\n");
}

function diffTable(title: string, a: SetResult, b: SetResult): string {
  const rows = a.outcomes.map((o, i) => ({ o, m: b.outcomes[i] }));
  const changed = rows.filter(({ o, m }) => o.report.verdict !== m.report.verdict);
  return [
    `### ${title}: rules only vs rules + model`,
    "",
    `| Metric | Rules only | Rules + model |`,
    "|---|---:|---:|",
    `| Verdict accuracy | ${a.metrics.verdictCorrect}/${a.metrics.n} | ${b.metrics.verdictCorrect}/${b.metrics.n} |`,
    `| Precision | ${pct(a.metrics.micro.tp, a.metrics.micro.tp + a.metrics.micro.fp)} | ${pct(b.metrics.micro.tp, b.metrics.micro.tp + b.metrics.micro.fp)} |`,
    `| Recall | ${pct(a.metrics.micro.tp, a.metrics.micro.tp + a.metrics.micro.fn)} | ${pct(b.metrics.micro.tp, b.metrics.micro.tp + b.metrics.micro.fn)} |`,
    `| Severity agreement | ${a.metrics.sev.agree}/${a.metrics.sev.scored} | ${b.metrics.sev.agree}/${b.metrics.sev.scored} |`,
    `| Model findings dropped | n/a | ${b.metrics.dropped}/${b.metrics.dropped + b.metrics.modelKept} |`,
    `| Model answered | n/a | ${b.metrics.usedLlm}/${b.metrics.n} |`,
    `| Median latency | ${a.metrics.medianMs.toFixed(0)} ms | ${b.metrics.medianMs.toFixed(0)} ms |`,
    "",
    "| Case | Expected | Rules only | Rules + model | Rules-only flags | Rules + model flags |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      ({ o, m }) =>
        `| ${o.c.id} | ${o.c.verdict} | ${o.report.verdict}${o.report.verdict === o.c.verdict ? "" : " (miss)"} | ${m.report.verdict}${
          m.report.verdict === o.c.verdict ? "" : " (miss)"
        } | ${why(o.report)} | ${why(m.report)} |`,
    ),
    "",
    changed.length
      ? "Verdict differences: " + changed.map(({ o, m }) => `${o.c.id} ${o.report.verdict} -> ${m.report.verdict}`).join("; ") + "."
      : "Verdict differences: none.",
    "",
  ].join("\n");
}

function diffConsole(title: string, a: SetResult, b: SetResult): string {
  const lines = [`${title}: rules only vs rules + model`, "  case                 expected  rules     model"];
  a.outcomes.forEach((o, i) => {
    const m = b.outcomes[i];
    const mark = o.report.verdict !== m.report.verdict ? "  <- differs" : "";
    lines.push("  " + o.c.id.padEnd(21) + o.c.verdict.padEnd(10) + o.report.verdict.padEnd(10) + m.report.verdict + mark);
  });
  return lines.join("\n");
}

const rulesOnly = new MockLlm();
const fxCases = fixtureCases();
const real = realCases();
const realList = real?.cases ?? [];

// The main run uses the configured provider (mock = rules only).
const fx = await evaluate(fxCases, llm, RUNS);
const rl = await evaluate(realList, llm, RUNS);

// Compare mode: a rules-only run next to a configured-model run.
let compareMd = "";
let compareOut = "";
if (COMPARE) {
  const reason = modelUnavailable();
  if (reason) {
    const msg = `Compare mode: model column skipped (${reason}). Set LLM_PROVIDER=anthropic and LLM_API_KEY in server/.env to compare.`;
    compareMd = `## Compare: rules only vs rules + model\n\n${msg}\n`;
    compareOut = msg;
  } else {
    const fxRules = await evaluate(fxCases, rulesOnly);
    const rlRules = await evaluate(realList, rulesOnly);
    compareMd =
      `## Compare: rules only vs rules + model (${providerLabel(llm)})\n\n` +
      diffTable("Fixture stores", fxRules, fx) +
      "\n" +
      (realList.length ? diffTable("Real-world policies", rlRules, rl) : "Real-world policies: not run.\n");
    compareOut = [
      diffConsole("Fixtures", fxRules, fx),
      realList.length ? diffConsole("Real-world", rlRules, rl) : "",
      realList.length ? consoleSummary("Real-world, rules only", rlRules.metrics) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}

const header = [
  "# Xcavate eval results",
  "",
  `Generated ${new Date().toISOString()} by \`npm run eval\`${COMPARE ? " (compare mode)" : ""}.`,
  "",
  `**Provider: ${providerLabel(llm)}.**`,
  "",
  "Scoring: a category counts as predicted when the report has a flag of that category. Any predicted category not in the",
  "label counts as a false positive (strict). \"Dropped by quote verification\" is model findings whose quote was not found in",
  "the policy text, over all model findings that reached verification (dropped + kept). The verdict counts money",
  "categories only (arbitration and data sharing are shown but never change it).",
  "",
].join("\n");

const fixtureNote =
  "Fictional fixture stores from `fixtures/golden.json` (built by the team with planted clauses, so these numbers show the " +
  "pipeline works end to end; they are not an accuracy claim about real sites).";
let realSection: string;
if (!real) realSection = "## Real-world policies\n\nNot run: `eval/real/labels.json` is not present (the folder is local-only and git-ignored).\n";
else if (rl.outcomes.length === 0)
  realSection = `## Real-world policies\n\nNo usable items in \`eval/real/labels.json\`.${real.skipped.length ? " Skipped: " + real.skipped.join(", ") + "." : ""}\n`;
else
  realSection = tables(
    "Real-world policies",
    rl.outcomes,
    rl.metrics,
    "Saved texts of real policies in `eval/real/` (local only), labels drafted by an AI research agent and not yet reviewed by a human, so treat these numbers as provisional. The rules were also tuned while looking at these texts, so this is not a held-out test. Each item is one policy analysed on its own (pageType \"none\")." +
      (real.skipped.length ? ` Skipped: ${real.skipped.join(", ")}.` : ""),
  );

const repeatOut = [repeatStats("Fixtures", fx, llm), realList.length ? repeatStats("Real-world", rl, llm) : ""].filter(Boolean).join("\n");
const md =
  header +
  "\n" +
  tables("Fixture stores", fx.outcomes, fx.metrics, fixtureNote) +
  "\n" +
  realSection +
  (compareMd ? "\n" + compareMd : "") +
  "\n## Repeats and latency\n\n```\n" +
  repeatOut +
  "\n```\n";
writeFileSync(join(EVAL_DIR, "results.md"), md);

process.stdout.write(
  [
    `Provider: ${providerLabel(llm)}`,
    consoleSummary("Fixtures", fx.metrics),
    real ? (rl.outcomes.length ? consoleSummary("Real-world", rl.metrics) : "Real-world: no usable items") : "Real-world: skipped (eval/real/labels.json not found)",
    ...(compareOut ? [compareOut] : []),
    repeatOut,
    "Wrote eval/results.md",
  ].join("\n\n") + "\n",
);
