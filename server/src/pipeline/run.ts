import { LIMITS, SEVERITY_RANK, domainOf, flagId, normalizeForHash, normalizeForMatch, sha256Hex } from "@xcavate/shared";
import type {
  AnalyzeRequest,
  CancellationInfo,
  Category,
  ChangeSummary,
  Flag,
  LlmOutput,
  PolicyInput,
  PolicyMeta,
  Report,
  TrialInfo,
} from "@xcavate/shared";
import type { LlmClient, LlmPolicyInput } from "../llm/client.js";
import { logError } from "../log.js";
import { analysisKey, changeKey } from "../store/store.js";
import type { CachedAnalysis, Store } from "../store/store.js";
import { diffParagraphs, isMoneyRelevant, ruleChangeBullets } from "./diff.js";
import { extractCancellation, extractTrial } from "./extract.js";
import { prefilter } from "./prefilter.js";
import { bestPerCategory, runRules } from "./rules.js";
import { MISSING_POLICY_FLAG, applyCaps, computeVerdict, needsMissingPolicy, sortFlags } from "./score.js";
import { splitParagraphs } from "./split.js";
import type { Paragraph } from "./split.js";
import { clip, clipWords } from "./textutil.js";
import { locateQuote, prepareForVerify, verifyQuote } from "./verify.js";
import type { VerifiablePolicy } from "./verify.js";

export interface PipelineDeps {
  store: Store;
  llm: LlmClient;
  now?: () => Date;
}

interface Prepared {
  input: PolicyInput;
  text: string;
  textHash: string;
  readable: boolean;
  paragraphs: Paragraph[];
}

async function prepare(p: PolicyInput): Promise<Prepared> {
  const text = normalizeForHash(p.text);
  const textHash = await sha256Hex(text);
  const readable = text.length >= LIMITS.minReadableChars;
  return { input: p, text, textHash, readable, paragraphs: readable ? splitParagraphs(text) : [] };
}

/** Run the full analysis for one request (section 7.4 steps 1 to 8). Never throws on LLM failure. */
export async function runAnalysis(req: AnalyzeRequest, deps: PipelineDeps): Promise<Report> {
  const t0 = performance.now();
  const { store, llm } = deps;
  const domain = domainOf(req.pageUrl);
  const prepared = await Promise.all(req.policies.map(prepare));

  for (const p of prepared) if (p.readable) store.putSnapshot(p.input.url, p.textHash, p.text);

  const key = analysisKey(prepared.map((p) => p.textHash));
  const hit = prepared.length > 0 ? store.getAnalysis(key) : undefined;

  const [analysis, changes] = await Promise.all([
    hit ? Promise.resolve(remapUrls(hit, prepared)) : analyzeFresh(prepared, llm),
    computeChanges(prepared, deps),
  ]);

  if (!hit && prepared.length > 0 && analysis.cacheable) {
    const { cacheable: _c, ...value } = analysis;
    store.putAnalysis(key, value);
  }

  const analyzedCount = analysis.policies.filter((p) => p.status === "analyzed").length;
  let flags = analysis.flags;
  if (needsMissingPolicy(req, analyzedCount)) flags = sortFlags([...flags, MISSING_POLICY_FLAG]);

  const report: Report = {
    schemaVersion: 1,
    domain,
    verdict: computeVerdict(flags, analyzedCount),
    flags,
    ...(analysis.trial ? { trial: analysis.trial } : {}),
    ...(analysis.cancellation ? { cancellation: analysis.cancellation } : {}),
    ...(changes.length ? { changes } : {}),
    policies: analysis.policies,
    stats: {
      droppedUnverified: analysis.droppedUnverified,
      usedLlm: analysis.usedLlm,
      ms: Math.round(performance.now() - t0),
    },
    cached: Boolean(hit),
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
  };

  // Latest report per domain for GET /v1/report; changes are per-visitor, so they are not stored.
  if (analyzedCount > 0) {
    const { changes: _ch, ...shared } = report;
    store.putLatestReport(domain, { ...shared, cached: false });
  }
  return report;
}

/** On a cache hit the same texts may come from different URLs: map URLs through the hashes. */
function remapUrls(a: CachedAnalysis, prepared: Prepared[]): CachedAnalysis & { cacheable: boolean } {
  const oldUrlToHash = new Map(a.policies.map((p) => [p.url, p.textHash]));
  const hashToUrl = new Map(prepared.map((p) => [p.textHash, p.input.url]));
  const url = (u: string) => hashToUrl.get(oldUrlToHash.get(u) ?? "") ?? u;
  return {
    ...a,
    flags: a.flags.map((f) => (f.policyUrl ? { ...f, policyUrl: url(f.policyUrl) } : f)),
    policies: prepared.map(meta),
    cacheable: false,
  };
}

function meta(p: Prepared): PolicyMeta {
  return { url: p.input.url, kind: p.input.kind, textHash: p.textHash, status: p.readable ? "analyzed" : "unreadable" };
}

interface Candidate {
  category: Exclude<Category, "missing_policy">;
  severity: Flag["severity"];
  title: string;
  summary: string;
  costImpact?: string;
  quote: string;
  policy: number;
  paragraphIndex: number;
}

async function toFlag(c: Candidate, prepared: Prepared[], source: Flag["source"]): Promise<Flag> {
  const flag: Flag = {
    id: await flagId(c.category, c.quote),
    category: c.category,
    severity: c.severity,
    title: clip(c.title.trim(), LIMITS.maxTitleChars),
    summary: clipWords(c.summary, LIMITS.maxSummaryWords),
    quote: c.quote,
    policyUrl: prepared[c.policy].input.url,
    paragraphIndex: c.paragraphIndex,
    source,
  };
  if (c.costImpact && c.costImpact.trim()) flag.costImpact = c.costImpact.trim();
  return flag;
}

function overlaps(a: Candidate, b: Candidate): boolean {
  if (a.policy === b.policy && a.paragraphIndex === b.paragraphIndex) return true;
  const x = normalizeForMatch(a.quote);
  const y = normalizeForMatch(b.quote);
  return x.includes(y) || y.includes(x);
}

const SUBSCRIPTION_CATEGORIES: Category[] = ["auto_renewal", "trial_converts", "cancellation_friction", "termination_fee"];

async function analyzeFresh(prepared: Prepared[], llm: LlmClient): Promise<CachedAnalysis & { cacheable: boolean }> {
  const readable = prepared.map((p, i) => ({ p, i })).filter((x) => x.p.readable);

  // Rules over every paragraph (cheap, and not limited by the prefilter budget).
  const ruleCands: Candidate[] = readable.flatMap(({ p, i }) =>
    runRules(p.paragraphs).map((h) => ({ ...h, policy: i })),
  );

  // Prefilter decides what the model sees. Paragraph ids are unique across the request.
  const { kept } = prefilter(readable.map((x) => ({ paragraphs: x.p.paragraphs })));
  const idMap = new Map<number, { policy: number; paragraphIndex: number }>();
  let nextId = 0;
  const llmInput: LlmPolicyInput[] = readable.map(({ p, i }, r) => ({
    url: p.input.url,
    kind: p.input.kind,
    paragraphs: kept[r].map((para) => {
      const id = nextId++;
      idMap.set(id, { policy: i, paragraphIndex: para.index });
      return { id, text: para.text };
    }),
  }));

  let out: LlmOutput | undefined;
  let llmFailed = false;
  if (nextId > 0) {
    try {
      out = await llm.analyze(llmInput.filter((p) => p.paragraphs.length > 0));
    } catch (e) {
      llmFailed = true;
      logError("llm.analyze", e instanceof Error && "kind" in e ? String((e as { kind: unknown }).kind) : "unknown");
    }
  }

  // Verify every model quote against the real text; drop what cannot be found.
  const verifiable: VerifiablePolicy[] = prepared.map((p) => prepareForVerify(p.text, p.paragraphs));
  let droppedUnverified = 0;
  const llmCands: Candidate[] = [];
  for (const f of out?.findings ?? []) {
    const ref = idMap.get(f.paragraphIndex);
    const quote = clip(f.quote.trim(), LIMITS.maxQuoteChars);
    const loc = locateQuote(quote, verifiable, ref?.policy ?? -1, ref?.paragraphIndex ?? -1);
    if (!loc || !prepared[loc.policy].readable) {
      droppedUnverified++;
      continue;
    }
    llmCands.push({
      category: f.category,
      severity: f.severity,
      title: f.title,
      summary: f.summary,
      costImpact: f.costImpact ?? undefined,
      quote,
      policy: loc.policy,
      paragraphIndex: loc.paragraphIndex,
    });
  }

  // Merge: one flag per category. Overlapping quotes become source "both"; a rules flag is
  // never removed because the model stayed silent, and severity takes the higher of the two.
  const rulesBest = bestPerCategory(ruleCands);
  const llmBest = bestPerCategory(llmCands);
  const flags: Flag[] = [];
  const cats = new Set<Category>([...rulesBest.map((c) => c.category), ...llmBest.map((c) => c.category)]);
  for (const cat of cats) {
    const r = rulesBest.find((c) => c.category === cat);
    const l = llmBest.find((c) => c.category === cat);
    if (r && l) {
      const severity = SEVERITY_RANK[r.severity] > SEVERITY_RANK[l.severity] ? r.severity : l.severity;
      if (overlaps(r, l)) flags.push(await toFlag({ ...l, severity, costImpact: l.costImpact ?? r.costImpact }, prepared, "both"));
      else if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[l.severity]) flags.push(await toFlag(r, prepared, "rules"));
      else flags.push(await toFlag(l, prepared, "llm"));
    } else if (r) flags.push(await toFlag(r, prepared, "rules"));
    else if (l) flags.push(await toFlag(l, prepared, "llm"));
  }
  const finalFlags = sortFlags(applyCaps(flags));

  // Trial and cancellation: the model's answer, gaps filled from rules (A-10).
  const allParas = readable.flatMap(({ p }) => p.paragraphs);
  const texts = readable.map(({ p }) => p.text);
  const trial = mergeTrial(out?.trial ?? null, extractTrial(allParas), texts);
  const subscriptionLike = Boolean(trial) || finalFlags.some((f) => SUBSCRIPTION_CATEGORIES.includes(f.category));
  const cancellation = subscriptionLike
    ? mergeCancellation(out?.cancellation ?? null, extractCancellation(allParas), texts)
    : undefined;

  return {
    flags: finalFlags,
    ...(trial ? { trial } : {}),
    ...(cancellation ? { cancellation } : {}),
    policies: prepared.map(meta),
    droppedUnverified,
    usedLlm: out !== undefined,
    cacheable: !llmFailed,
  };
}

function quoteIfVerified(q: string | null | undefined, texts: string[]): string | undefined {
  if (!q) return undefined;
  const c = clip(q.trim(), LIMITS.maxQuoteChars);
  return texts.some((t) => verifyQuote(c, t)) ? c : undefined;
}

function mergeTrial(l: LlmOutput["trial"], r: TrialInfo | undefined, texts: string[]): TrialInfo | undefined {
  const t: TrialInfo = {};
  const lengthDays = l?.lengthDays && l.lengthDays > 0 ? l.lengthDays : r?.lengthDays;
  if (lengthDays) t.lengthDays = lengthDays;
  const priceAfter = l?.priceAfter?.trim() || r?.priceAfter;
  if (priceAfter) t.priceAfter = priceAfter;
  const billingPeriod = l?.billingPeriod ?? r?.billingPeriod;
  if (billingPeriod) t.billingPeriod = billingPeriod;
  const quote = quoteIfVerified(l?.quote, texts) ?? r?.quote;
  if (quote) t.quote = quote;
  return t.lengthDays || t.priceAfter ? t : undefined;
}

function mergeCancellation(
  l: LlmOutput["cancellation"],
  r: CancellationInfo | undefined,
  texts: string[],
): CancellationInfo | undefined {
  if (!l && !r) return undefined;
  const method = l && l.method !== "unknown" ? l.method : r?.method ?? l?.method ?? "unknown";
  const steps = (l?.steps?.length ? l.steps : r?.steps ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 4);
  const c: CancellationInfo = { method, steps };
  const noticeDays = l?.noticeDays ?? r?.noticeDays;
  if (noticeDays !== undefined && noticeDays !== null && noticeDays >= 0) c.noticeDays = noticeDays;
  const contact = l?.contact?.trim() || r?.contact;
  if (contact) c.contact = contact;
  const quote = quoteIfVerified(l?.quote, texts) ?? r?.quote;
  if (quote) c.quote = quote;
  if (c.method === "unknown" && c.noticeDays === undefined && !c.contact) return undefined;
  return c;
}

/** Change summaries for policies whose previousHash differs from the current text (A-11). */
async function computeChanges(prepared: Prepared[], deps: PipelineDeps): Promise<ChangeSummary[]> {
  const out: ChangeSummary[] = [];
  for (const p of prepared) {
    const prev = p.input.previousHash;
    if (!prev || prev === p.textHash || !p.readable) continue;
    const ck = changeKey(p.input.url, prev, p.textHash);
    const known = deps.store.getChange(ck);
    if (known) {
      out.push(known);
      continue;
    }
    const old = deps.store.getSnapshot(p.input.url, prev);
    if (old === undefined) continue; // We never saw the old text, so we cannot say what changed.
    const { added, removed } = diffParagraphs(old, p.text);
    if (added.length === 0 && removed.length === 0) continue;
    const moneyRelevant = isMoneyRelevant(added, removed);
    let bullets: string[] = [];
    let failed = false;
    if (moneyRelevant) {
      try {
        bullets = (await deps.llm.summarizeChanges({ policyUrl: p.input.url, added, removed }))
          .map((b) => b.trim())
          .filter(Boolean)
          .slice(0, 3);
      } catch (e) {
        failed = true;
        logError("llm.summarizeChanges", e instanceof Error && "kind" in e ? String((e as { kind: unknown }).kind) : "unknown");
      }
    }
    if (bullets.length === 0) bullets = ruleChangeBullets(added, removed);
    const cs: ChangeSummary = { policyUrl: p.input.url, bullets, moneyRelevant };
    if (!failed) deps.store.putChange(ck, cs);
    out.push(cs);
  }
  return out;
}
