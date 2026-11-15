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
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY_ORDER, GoldenSchema, stripPageUrl } from "@xcavate/shared";
import type { AnalyzeRequest, Category, PolicyKind, Report, Verdict } from "@xcavate/shared";
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
  evidence: z.unknown().optional(),
});

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
  perCategory: { category: Category; tp: number; fp: number; fn: number }[];
  micro: { tp: number; fp: number; fn: number };
  verdictCorrect: number;
  dropped: number;
  modelKept: number;
  medianMs: number;
  usedLlm: number;
  forbiddenHits: string[];
}

function score(outcomes: Outcome[]): Metrics {
  const perCategory = CATEGORY_ORDER.map((category) => ({ category, tp: 0, fp: 0, fn: 0 }));
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
  return { n: outcomes.length, perCategory, micro, verdictCorrect, dropped, modelKept, medianMs, usedLlm, forbiddenHits };
}

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
    "| Category | TP | FP | FN | Precision | Recall |",
    "|---|---:|---:|---:|---:|---:|",
    ...rows.map((r) => `| ${r.category} | ${r.tp} | ${r.fp} | ${r.fn} | ${pct(r.tp, r.tp + r.fp)} | ${pct(r.tp, r.tp + r.fn)} |`),
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
    "  category               TP  FP  FN  prec  recall",
    ...rows.map(
      (r) =>
        "  " + r.category.padEnd(22) + String(r.tp).padStart(3) + String(r.fp).padStart(4) + String(r.fn).padStart(4) + pct(r.tp, r.tp + r.fp).padStart(6) + pct(r.tp, r.tp + r.fn).padStart(8),
    ),
  ].join("\n");
}

// ---------- main ----------

/** "no_refund:high, auto_renewal:low": the flags behind a verdict. */
const why = (r: Report) => r.flags.map((f) => `${f.category}:${f.severity}`).join(", ") || "none";

interface SetResult {
  outcomes: Outcome[];
  metrics: Metrics;
}

async function evaluate(cases: Case[], client: LlmClient): Promise<SetResult> {
  const outcomes = cases.length ? await run(cases, client) : [];
  return { outcomes, metrics: score(outcomes) };
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
const fx = await evaluate(fxCases, llm);
const rl = await evaluate(realList, llm);

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
    compareOut = [diffConsole("Fixtures", fxRules, fx), realList.length ? diffConsole("Real-world", rlRules, rl) : ""].filter(Boolean).join("\n\n");
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

const md = header + "\n" + tables("Fixture stores", fx.outcomes, fx.metrics, fixtureNote) + "\n" + realSection + (compareMd ? "\n" + compareMd : "");
writeFileSync(join(EVAL_DIR, "results.md"), md);

process.stdout.write(
  [
    `Provider: ${providerLabel(llm)}`,
    consoleSummary("Fixtures", fx.metrics),
    real ? (rl.outcomes.length ? consoleSummary("Real-world", rl.metrics) : "Real-world: no usable items") : "Real-world: skipped (eval/real/labels.json not found)",
    ...(compareOut ? [compareOut] : []),
    "Wrote eval/results.md",
  ].join("\n\n") + "\n",
);
