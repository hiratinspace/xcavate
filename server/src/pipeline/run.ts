import { domainOf } from "@xcavate/shared";
import type { AnalyzeRequest, ChangeSummary, Report } from "@xcavate/shared";
import {
  analyzePrepared,
  contactsGrounded,
  corpus,
  diffParagraphs,
  finishReport,
  hasSafetyClaim,
  isMoneyRelevant,
  moneyGrounded,
  planModelInput,
  policyMeta,
  preparePolicy,
  ruleChangeBullets,
} from "@xcavate/shared/engine";
import type { Analysis, Corpus, Prepared } from "@xcavate/shared/engine";
import { LlmError } from "../llm/client.js";
import type { LlmClient } from "../llm/client.js";
import { logError } from "../log.js";
import { guardStore } from "../store/index.js";
import { analysisKey, changeKey } from "../store/store.js";
import type { CachedAnalysis, Store } from "../store/store.js";

/**
 * Bump whenever rules, prompts or merging change in a way that changes reports, so cached
 * analyses from an older pipeline are never served (part of the cache key).
 */
export const PIPELINE_VERSION = 3;

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
  const prepared = await Promise.all(req.policies.map(preparePolicy));

  // Snapshots feed change alerts. A manual scan ("other" on a non-checkout page) is the live page
  // the user is looking at and may hold their personal data, so it is never stored.
  const manualScan = (p: Prepared) => p.input.kind === "other" && req.pageType === "none";
  for (const p of prepared) if (p.readable && !manualScan(p)) store.putSnapshot(p.input.url, p.textHash, p.text);

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

  const report: Report = finishReport(req, analysis, {
    changes,
    cached: Boolean(hit),
    ms: performance.now() - t0,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
  });

  // Latest report per domain for GET /v1/report; changes are per-visitor, so they are not stored.
  if (deps.publishShared && analysis.policies.some((p) => p.status === "analyzed")) {
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
    policies: prepared.map(policyMeta),
    cacheable: false,
  };
}

/** Rules over every paragraph plus the model's verified findings (engine), with the model call here. */
async function analyzeFresh(prepared: Prepared[], llm: LlmClient, signal: AbortSignal): Promise<Analysis & { cacheable: boolean }> {
  const plan = planModelInput(prepared);
  let out: Awaited<ReturnType<LlmClient["analyze"]>> | undefined;
  let llmFailed = false;
  if (plan.count > 0) {
    try {
      out = await withDeadline(llm.analyze(plan.input, { signal }), signal);
    } catch (e) {
      llmFailed = true;
      logError("llm.analyze", errKind(e));
    }
  }
  // The mock is the rules engine, not a model: its agreement is not a second opinion (V-03).
  const analysis = await analyzePrepared(prepared, { out, idMap: plan.idMap, isModel: llm.provider !== "mock" });
  return { ...analysis, cacheable: !llmFailed };
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
