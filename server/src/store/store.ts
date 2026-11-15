import type { CancellationInfo, ChangeSummary, Flag, PolicyMeta, Report, TrialInfo } from "@xcavate/shared";

/** The policy-dependent part of a report, cached by sorted policy hashes (A-08). */
export interface CachedAnalysis {
  flags: Flag[];
  trial?: TrialInfo;
  cancellation?: CancellationInfo;
  policies: PolicyMeta[];
  droppedUnverified: number;
  usedLlm: boolean;
}

/**
 * Storage behind one interface. Synchronous on purpose: both implementations
 * (node:sqlite DatabaseSync and an in-memory Map) are synchronous.
 */
export interface Store {
  readonly kind: "sqlite" | "memory";
  getAnalysis(key: string): CachedAnalysis | undefined;
  putAnalysis(key: string, value: CachedAnalysis): void;
  /** Latest report per domain, for GET /v1/report. */
  getLatestReport(domain: string): Report | undefined;
  putLatestReport(domain: string, report: Report): void;
  /** Policy text snapshots by (url, textHash), for change summaries (A-11). */
  getSnapshot(url: string, hash: string): string | undefined;
  putSnapshot(url: string, hash: string, text: string): void;
  /** Change summaries by (url, previousHash, textHash), so repeat requests make no LLM call. */
  getChange(key: string): ChangeSummary | undefined;
  putChange(key: string, value: ChangeSummary): void;
  close(): void;
}

/** Cache key: the sorted policy hashes (A-08). */
export function analysisKey(hashes: string[]): string {
  return [...hashes].sort().join(",");
}

export function changeKey(url: string, previousHash: string, textHash: string): string {
  return url + "|" + previousHash + "|" + textHash;
}
