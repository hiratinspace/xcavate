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
 * Analyses and latest reports expire after `ttlMs`; snapshots keep the last
 * SNAPSHOTS_PER_URL versions per URL and at most MAX_SNAPSHOTS in total.
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

export interface StoreOptions {
  /** Lifetime of cached analyses and latest reports. Default 7 days. */
  ttlMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
}

export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SNAPSHOTS_PER_URL = 2;
export const MAX_SNAPSHOTS = 2_000;
/** Caps for the other tables (oldest evicted first). */
export const MAX_ENTRIES = 5_000;

/**
 * Cache key: a salt (pipeline version, provider, model) plus the sorted policy hashes (A-08).
 * The salt means a new pipeline or model never serves results computed by an older one.
 */
export function analysisKey(hashes: string[], salt = ""): string {
  return salt + "|" + [...hashes].sort().join(",");
}

export function changeKey(url: string, previousHash: string, textHash: string, salt = ""): string {
  return salt + "|" + url + "|" + previousHash + "|" + textHash;
}
