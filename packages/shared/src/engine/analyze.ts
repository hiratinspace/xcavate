import { LIMITS, SEVERITY_RANK, domainOf, flagId, normalizeForHash, normalizeForMatch, sha256Hex } from "../core.js";
import type {
  AnalyzeRequest,
  CancellationInfo,
  Category,
  ChangeSummary,
  Flag,
  LlmOutput,
  PolicyInput,
  PolicyKind,
  PolicyMeta,
  Report,
  TrialInfo,
} from "../core.js";
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
import { bestPerCategory, offersOnlineCancel, runRules, statesNoReminder } from "./rules.js";
import { MISSING_POLICY_FLAG, applyCaps, computeVerdict, needsMissingPolicy, recalibrate, sortFlags } from "./score.js";
import { rightsNotes, withRightsNotes } from "./rights.js";
import { splitParagraphs } from "./split.js";
import type { Paragraph } from "./split.js";
import { clip, clipWords } from "./textutil.js";
import { locateQuote, prepareForVerify, verifyQuote } from "./verify.js";
import type { VerifiablePolicy } from "./verify.js";

/**
 * The analysis steps shared by the server and the extension (V-06): everything in section 7.4
 * except the model call itself, the store and change summaries. The server runs the model
 * between `planModelInput` and `analyzePrepared`; the extension skips it (`runRulesOnly`).
 */

/** One policy as the model sees it: kept paragraphs with request-wide ids. */
export interface LlmPolicyInput {
  url: string;
  kind: PolicyKind;
  /** `id` is unique across the whole request, so findings can be mapped back to a policy. */
  paragraphs: { id: number; text: string }[];
}

export interface Prepared {
  input: PolicyInput;
  text: string;
  textHash: string;
  readable: boolean;
  paragraphs: Paragraph[];
}

/** The report-relevant result of analysing a set of policy texts (what the server caches). */
export interface Analysis {
  flags: Flag[];
  trial?: TrialInfo;
  cancellation?: CancellationInfo;
  policies: PolicyMeta[];
  droppedUnverified: number;
  usedLlm: boolean;
}

export async function preparePolicy(p: PolicyInput): Promise<Prepared> {
  const text = normalizeForHash(p.text);
  const textHash = await sha256Hex(text);
  const readable = text.length >= LIMITS.minReadableChars;
  return { input: p, text, textHash, readable, paragraphs: readable ? splitParagraphs(text) : [] };
}

export function policyMeta(p: Prepared): PolicyMeta {
  return { url: p.input.url, kind: p.input.kind, textHash: p.textHash, status: p.readable ? "analyzed" : "unreadable" };
}

export type IdMap = Map<number, { policy: number; paragraphIndex: number }>;

export interface ModelPlan {
  /** Policies with at least one kept paragraph, ready for the model. */
  input: LlmPolicyInput[];
  idMap: IdMap;
  /** Number of paragraphs the model would see; 0 means no model call. */
  count: number;
}

/** Prefilter decides what the model sees. Paragraph ids are unique across the request. */
export function planModelInput(prepared: Prepared[]): ModelPlan {
  const readable = prepared.map((p, i) => ({ p, i })).filter((x) => x.p.readable);
  const { kept } = prefilter(readable.map((x) => ({ paragraphs: x.p.paragraphs })));
  const idMap: IdMap = new Map();
  let nextId = 0;
  const input: LlmPolicyInput[] = readable.map(({ p, i }, r) => ({
    url: p.input.url,
    kind: p.input.kind,
    paragraphs: kept[r].map((para) => {
      const id = nextId++;
      idMap.set(id, { policy: i, paragraphIndex: para.index });
      return { id, text: para.text };
    }),
  }));
  return { input: input.filter((p) => p.paragraphs.length > 0), idMap, count: nextId };
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

export interface ModelAnswer {
  /** The model's answer, or undefined when there was no call or it failed (rules only). */
  out?: LlmOutput;
  idMap?: IdMap;
  /** False for the mock: its agreement is not a second opinion, so flags stay source "rules" (V-03). */
  isModel: boolean;
}

/**
 * Rules over every paragraph, merged with the model's verified findings when there are any,
 * then severity caps and the V-01 recalibration. With no model answer this is the rules-only
 * analysis the extension shows first.
 */
export async function analyzePrepared(prepared: Prepared[], model: ModelAnswer = { isModel: false }): Promise<Analysis> {
  const { out, idMap = new Map(), isModel } = model;
  const readable = prepared.map((p, i) => ({ p, i })).filter((x) => x.p.readable);
  const texts = readable.map(({ p }) => p.text);
  const cx: Corpus = corpus(texts);

  // Rules over every paragraph (cheap, and not limited by the prefilter budget).
  const ruleCands: Candidate[] = readable.flatMap(({ p, i }) =>
    runRules(p.paragraphs).map((h) => ({ ...h, policy: i, trusted: true })),
  );

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
  // V-01: renewal and trial severity follow the whole document (online cancel path, harsh
  // cancellation, reminders, price rises), decided in code for rules and model flags alike.
  const allParas = readable.flatMap(({ p }) => p.paragraphs);
  const capped = applyCaps(flags);
  const calibrated = recalibrate(capped, {
    onlineCancel: offersOnlineCancel(allParas),
    harshCancel: capped.some((f) => f.category === "cancellation_friction" && f.severity === "high"),
    noReminder: statesNoReminder(allParas),
    priceCanRise: capped.some((f) => f.category === "price_change"),
  });
  const finalFlags = sortFlags(applyCaps(calibrated)).map((f) => (isModel ? f : { ...f, source: "rules" as const }));

  // Trial and cancellation: the model's answer where the text backs it, gaps filled from rules (A-10).
  const trial = mergeTrial(out?.trial ?? null, extractTrial(allParas), texts, cx);
  const subscriptionLike = Boolean(trial) || finalFlags.some((f) => SUBSCRIPTION_CATEGORIES.includes(f.category));
  const cancellation = subscriptionLike
    ? mergeCancellation(out?.cancellation ?? null, extractCancellation(allParas), texts, cx)
    : undefined;

  return {
    flags: finalFlags,
    ...(trial ? { trial } : {}),
    ...(cancellation ? { cancellation } : {}),
    policies: prepared.map(policyMeta),
    droppedUnverified,
    usedLlm: out !== undefined && isModel,
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

export interface ReportExtras {
  changes?: ChangeSummary[];
  cached?: boolean;
  ms: number;
  generatedAt: string;
}

/**
 * Per-request steps on top of an analysis (section 7.4 steps 7 and 8): missing_policy,
 * V-08 rights notes (they depend on the page, so they are never cached), and the verdict.
 */
export function finishReport(req: Pick<AnalyzeRequest, "pageUrl" | "pageType" | "linksFound">, analysis: Analysis, extras: ReportExtras): Report {
  const analyzedKinds = analysis.policies.filter((p) => p.status === "analyzed").map((p) => p.kind);
  let flags = analysis.flags;
  if (needsMissingPolicy(req, analyzedKinds.length)) flags = sortFlags([...flags, MISSING_POLICY_FLAG]);
  flags = withRightsNotes(flags, rightsNotes({ flags, trial: analysis.trial, cancellation: analysis.cancellation }, req.pageUrl));
  const changes = extras.changes ?? [];
  return {
    schemaVersion: 1,
    domain: domainOf(req.pageUrl),
    verdict: computeVerdict(flags, analyzedKinds),
    flags,
    ...(analysis.trial ? { trial: analysis.trial } : {}),
    ...(analysis.cancellation ? { cancellation: analysis.cancellation } : {}),
    ...(changes.length ? { changes } : {}),
    policies: analysis.policies,
    stats: {
      droppedUnverified: analysis.droppedUnverified,
      usedLlm: analysis.usedLlm,
      ms: Math.max(0, Math.round(extras.ms)),
    },
    cached: Boolean(extras.cached),
    generatedAt: extras.generatedAt,
  };
}

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * V-06: the whole verdict on this device, with no model and no network. Same rules, caps,
 * recalibration, partial and missing_policy logic as the server; `stats.usedLlm` is false and
 * there are no change summaries (those need the server's snapshots).
 */
export async function runRulesOnly(req: AnalyzeRequest, opts: { now?: () => Date } = {}): Promise<Report> {
  const t0 = nowMs();
  const prepared = await Promise.all(req.policies.map(preparePolicy));
  const analysis = await analyzePrepared(prepared);
  return finishReport(req, analysis, { ms: nowMs() - t0, generatedAt: (opts.now?.() ?? new Date()).toISOString() });
}
