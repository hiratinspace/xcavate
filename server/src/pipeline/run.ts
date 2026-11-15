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
import { LlmError } from "../llm/client.js";
import type { LlmClient, LlmPolicyInput } from "../llm/client.js";
import { logError } from "../log.js";
import { guardStore } from "../store/index.js";
import { analysisKey, changeKey } from "../store/store.js";
import type { CachedAnalysis, Store } from "../store/store.js";
import { diffParagraphs, isMoneyRelevant, ruleChangeBullets } from "./diff.js";
import { extractCancellation, extractTrial } from "./extract.js";
import {
  contactsGrounded,
  corpus,
  daysGrounded,
  hasSafetyClaim,
  methodGrounded,
  moneyGrounded,
  periodGrounded,
  quoteSupportsCategory,
  stepGrounded,
  templateText,
  textGrounded,
  trialQuoteMatches,
  unsanitize,
} from "./ground.js";
import type { Corpus } from "./ground.js";
import { prefilter } from "./prefilter.js";
import { bestPerCategory, runRules } from "./rules.js";
import { MISSING_POLICY_FLAG, applyCaps, computeVerdict, needsMissingPolicy, sortFlags } from "./score.js";
import { splitParagraphs } from "./split.js";
import type { Paragraph } from "./split.js";
import { clip, clipWords } from "./textutil.js";
import { locateQuote, prepareForVerify, verifyQuote } from "./verify.js";
import type { VerifiablePolicy } from "./verify.js";

/**
 * Bump whenever rules, prompts or merging change in a way that changes reports, so cached
 * analyses from an older pipeline are never served (part of the cache key).
 */
export const PIPELINE_VERSION = 2;

export const DEFAULT_DEADLINE_MS = 12_000;

export interface PipelineDeps {
  store: Store;
  llm: LlmClient;
  now?: () => Date;
  /**
   * Publish this report as the shared latest report for its domain (GET /v1/report).
   * Only trusted callers (the seed script) set this. Client-submitted text is unverified, so letting
   * anonymous POSTs write the shared per-domain report would let anyone poison it for every visitor.
   */
  publishShared?: boolean;
  /** One deadline for every LLM call of this request (analysis and change summaries run in parallel). */
  deadlineMs?: number;
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

function errKind(e: unknown): string {
  return e instanceof Error && "kind" in e ? String((e as { kind: unknown }).kind) : "unknown";
}

/** Reject when the request deadline passes, even if the client ignores the abort signal. */
function withDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new LlmError("timeout", "request deadline exceeded"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LlmError("timeout", "request deadline exceeded"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Run the full analysis for one request (section 7.4 steps 1 to 8). Never throws on LLM or store failure. */
export async function runAnalysis(req: AnalyzeRequest, deps: PipelineDeps): Promise<Report> {
  const t0 = performance.now();
  const { llm } = deps;
  const store = guardStore(deps.store);
  const signal = AbortSignal.timeout(deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const salt = `p${PIPELINE_VERSION}|${llm.provider}|${llm.model}`;
  const domain = domainOf(req.pageUrl);
  const prepared = await Promise.all(req.policies.map(prepare));

  for (const p of prepared) if (p.readable) store.putSnapshot(p.input.url, p.textHash, p.text);

  const key = analysisKey(
    prepared.map((p) => p.textHash),
    salt,
  );
  const hit = prepared.length > 0 ? store.getAnalysis(key) : undefined;

  const [analysis, changes] = await Promise.all([
    hit ? Promise.resolve(remapUrls(hit, prepared)) : analyzeFresh(prepared, llm, signal),
    computeChanges(prepared, store, llm, salt, signal),
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
  if (deps.publishShared && analyzedCount > 0) {
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
  /** False when the model's title/summary made a safety claim or named amounts/contacts not in the text. */
  trusted: boolean;
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

async function analyzeFresh(
  prepared: Prepared[],
  llm: LlmClient,
  signal: AbortSignal,
): Promise<CachedAnalysis & { cacheable: boolean }> {
  const readable = prepared.map((p, i) => ({ p, i })).filter((x) => x.p.readable);
  const texts = readable.map(({ p }) => p.text);
  const cx: Corpus = corpus(texts);

  // Rules over every paragraph (cheap, and not limited by the prefilter budget).
  const ruleCands: Candidate[] = readable.flatMap(({ p, i }) =>
    runRules(p.paragraphs).map((h) => ({ ...h, policy: i, trusted: true })),
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
      out = await withDeadline(llm.analyze(llmInput.filter((p) => p.paragraphs.length > 0), { signal }), signal);
    } catch (e) {
      llmFailed = true;
      logError("llm.analyze", errKind(e));
    }
  }

  // Verify every model quote: in one paragraph of the real text, at least 5 words, and actually
  // evidence for its category (a non-negated keyword). Drop what fails.
  const verifiable: VerifiablePolicy[] = prepared.map((p) => prepareForVerify(p.text, p.paragraphs));
  let droppedUnverified = 0;
  const llmCands: Candidate[] = [];
  for (const f of out?.findings ?? []) {
    const ref = idMap.get(f.paragraphIndex);
    const quote = clip(unsanitize(f.quote).trim(), LIMITS.maxQuoteChars);
    const loc = locateQuote(quote, verifiable, ref?.policy ?? -1, ref?.paragraphIndex ?? -1);
    if (!loc || !prepared[loc.policy].readable || !quoteSupportsCategory(f.category, quote)) {
      droppedUnverified++;
      continue;
    }
    const trusted = textGrounded([f.title, f.summary], cx);
    const tpl = templateText(f.category);
    const cost = f.costImpact && !hasSafetyClaim(f.costImpact) && moneyGrounded(f.costImpact, cx) ? f.costImpact : undefined;
    llmCands.push({
      category: f.category,
      severity: f.severity,
      title: trusted ? f.title : tpl.title,
      summary: trusted ? f.summary : tpl.summary,
      costImpact: cost,
      quote,
      policy: loc.policy,
      paragraphIndex: loc.paragraphIndex,
      trusted,
    });
  }

  // Merge: one flag per category. Overlapping quotes become source "both"; a rules flag is
  // never removed because the model stayed silent, and severity takes the higher of the two.
  // Untrusted model wording yields to the rules wording.
  const rulesBest = bestPerCategory(ruleCands);
  const llmBest = bestPerCategory(llmCands);
  const flags: Flag[] = [];
  const cats = new Set<Category>([...rulesBest.map((c) => c.category), ...llmBest.map((c) => c.category)]);
  for (const cat of cats) {
    const r = rulesBest.find((c) => c.category === cat);
    const l = llmBest.find((c) => c.category === cat);
    if (r && l) {
      const severity = SEVERITY_RANK[r.severity] > SEVERITY_RANK[l.severity] ? r.severity : l.severity;
      const words = l.trusted ? l : r;
      if (overlaps(r, l))
        flags.push(
          await toFlag(
            { ...l, title: words.title, summary: words.summary, severity, costImpact: l.costImpact ?? r.costImpact },
            prepared,
            "both",
          ),
        );
      else if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[l.severity]) flags.push(await toFlag(r, prepared, "rules"));
      else flags.push(await toFlag(l, prepared, "llm"));
    } else if (r) flags.push(await toFlag(r, prepared, "rules"));
    else if (l) flags.push(await toFlag(l, prepared, "llm"));
  }
  const finalFlags = sortFlags(applyCaps(flags));

  // Trial and cancellation: the model's answer where the text backs it, gaps filled from rules (A-10).
  const allParas = readable.flatMap(({ p }) => p.paragraphs);
  const trial = mergeTrial(out?.trial ?? null, extractTrial(allParas), texts, cx);
  const subscriptionLike = Boolean(trial) || finalFlags.some((f) => SUBSCRIPTION_CATEGORIES.includes(f.category));
  const cancellation = subscriptionLike
    ? mergeCancellation(out?.cancellation ?? null, extractCancellation(allParas), texts, cx)
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
  const c = clip(unsanitize(q).trim(), LIMITS.maxQuoteChars);
  return texts.some((t) => verifyQuote(c, t)) ? c : undefined;
}

function mergeTrial(l: LlmOutput["trial"], r: TrialInfo | undefined, texts: string[], cx: Corpus): TrialInfo | undefined {
  const t: TrialInfo = {};
  const lLen = l?.lengthDays && l.lengthDays > 0 && daysGrounded(l.lengthDays, cx) ? l.lengthDays : undefined;
  const lengthDays = lLen ?? r?.lengthDays;
  if (lengthDays) t.lengthDays = lengthDays;
  const lPrice = l?.priceAfter?.trim();
  const priceAfter = lPrice && moneyGrounded(lPrice, cx) && /\d/.test(lPrice) ? lPrice : r?.priceAfter;
  if (priceAfter) t.priceAfter = priceAfter;
  const billingPeriod = l?.billingPeriod && periodGrounded(l.billingPeriod, cx) ? l.billingPeriod : r?.billingPeriod;
  if (billingPeriod) t.billingPeriod = billingPeriod;
  // Only a quote that states the length and price shown is attached.
  const quote = [quoteIfVerified(l?.quote, texts), r?.quote].find(
    (q): q is string => Boolean(q) && trialQuoteMatches(q as string, t.lengthDays, t.priceAfter),
  );
  if (quote) t.quote = quote;
  return t.lengthDays || t.priceAfter ? t : undefined;
}

function mergeCancellation(
  l: LlmOutput["cancellation"],
  r: CancellationInfo | undefined,
  texts: string[],
  cx: Corpus,
): CancellationInfo | undefined {
  if (!l && !r) return undefined;
  const lMethod = l && l.method !== "unknown" && methodGrounded(l.method, cx) ? l.method : undefined;
  const method = lMethod ?? r?.method ?? "unknown";
  const lSteps = (l?.steps ?? []).map((s) => s.trim()).filter((s) => s && stepGrounded(s, cx));
  // Model steps only when the model's method is the one shown, so steps and method agree.
  const steps = (lMethod && lMethod === method && lSteps.length ? lSteps : r?.steps ?? []).slice(0, 4);
  const c: CancellationInfo = { method, steps };
  const lNotice = l?.noticeDays !== null && l?.noticeDays !== undefined && l.noticeDays > 0 && daysGrounded(l.noticeDays, cx) ? l.noticeDays : undefined;
  const noticeDays = lNotice ?? r?.noticeDays;
  if (noticeDays !== undefined && noticeDays >= 0) c.noticeDays = noticeDays;
  const lContact = l?.contact?.trim();
  const contact = lContact && contactsGrounded(lContact, cx) && normalizedIn(lContact, cx) ? lContact : r?.contact;
  if (contact) c.contact = contact;
  const quote = quoteIfVerified(l?.quote, texts) ?? r?.quote;
  if (quote) c.quote = quote;
  if (c.method === "unknown" && c.noticeDays === undefined && !c.contact) return undefined;
  return c;
}

/** The contact string itself (or, for phone numbers, its digits) appears in the text. */
function normalizedIn(s: string, cx: Corpus): boolean {
  const n = normalizeForMatch(s);
  if (cx.some((t) => t.includes(n))) return true;
  const d = s.replace(/\D/g, "");
  return d.length >= 7 && cx.some((t) => t.replace(/\D/g, "").includes(d));
}

/** Model change bullets are used only when they make no safety claim and every amount is in the old or new text. */
function bulletsGrounded(bullets: string[], cx: Corpus): boolean {
  return bullets.every((b) => !hasSafetyClaim(b) && moneyGrounded(b, cx) && contactsGrounded(b, cx));
}

/**
 * Change summaries for policies whose previousHash differs from the current text (A-11).
 * All summaries run in parallel under the request deadline; a timeout or untrustworthy
 * model answer falls back to rules-based bullets.
 */
async function computeChanges(
  prepared: Prepared[],
  store: Store,
  llm: LlmClient,
  salt: string,
  signal: AbortSignal,
): Promise<ChangeSummary[]> {
  const results = await Promise.all(
    prepared.map(async (p): Promise<ChangeSummary | undefined> => {
      const prev = p.input.previousHash;
      if (!prev || prev === p.textHash || !p.readable) return undefined;
      const ck = changeKey(p.input.url, prev, p.textHash, salt);
      const known = store.getChange(ck);
      if (known) return known;
      const old = store.getSnapshot(p.input.url, prev);
      if (old === undefined) return undefined; // We never saw the old text, so we cannot say what changed.
      const { added, removed } = diffParagraphs(old, p.text);
      if (added.length === 0 && removed.length === 0) return undefined;
      const moneyRelevant = isMoneyRelevant(added, removed);
      let bullets: string[] = [];
      let failed = false;
      if (moneyRelevant) {
        try {
          bullets = (await withDeadline(llm.summarizeChanges({ policyUrl: p.input.url, added, removed }, { signal }), signal))
            .map((b) => b.trim())
            .filter(Boolean)
            .slice(0, 3);
          if (!bulletsGrounded(bullets, corpus([old, p.text]))) bullets = [];
        } catch (e) {
          failed = true;
          logError("llm.summarizeChanges", errKind(e));
        }
      }
      if (bullets.length === 0) bullets = ruleChangeBullets(added, removed);
      const cs: ChangeSummary = { policyUrl: p.input.url, bullets, moneyRelevant };
      if (!failed) store.putChange(ck, cs);
      return cs;
    }),
  );
  return results.filter((c): c is ChangeSummary => c !== undefined);
}
