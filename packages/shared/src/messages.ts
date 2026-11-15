import type { AnalyzeRequest, DarkPatternFinding, FeeSummary, PageType, Report, TabStatus } from "./types.js";

/** chrome.runtime message types (section 6.3). */
export const MSG = {
  PING: "PING",
  PAGE_READY: "PAGE_READY",
  FETCH_HTML: "FETCH_HTML",
  ANALYZE: "ANALYZE",
  LOCAL_FINDINGS: "LOCAL_FINDINGS",
  REPORT: "REPORT",
  SCAN_CURRENT_PAGE: "SCAN_CURRENT_PAGE",
  GET_STATE: "GET_STATE",
  SCAN_TAB: "SCAN_TAB",
  STATUS: "STATUS",
  SET_DISMISSED: "SET_DISMISSED",
} as const;

export type Message =
  | { type: "PING" }
  | { type: "PAGE_READY"; pageType: PageType; score: number; url: string }
  | { type: "FETCH_HTML"; url: string }
  | ({ type: "ANALYZE" } & { request: AnalyzeRequest })
  | { type: "LOCAL_FINDINGS"; fees?: FeeSummary; darkPatterns?: DarkPatternFinding[] }
  | { type: "REPORT"; report: Report }
  | { type: "SCAN_CURRENT_PAGE" }
  | { type: "GET_STATE"; tabId: number }
  | { type: "SCAN_TAB"; tabId: number }
  /**
   * bg → content: status changed (e.g. error), so the card can hide its "checking" state.
   * content → bg: the run failed after PAGE_READY (status "error"), so the tab leaves "checking".
   */
  | { type: "STATUS"; status: TabStatus }
  /** content → bg: the user closed (or a scan reopened) the card; remembered per tab + domain. */
  | { type: "SET_DISMISSED"; dismissed: boolean };

/**
 * paused: extension disabled or site paused (U-04); the content script then does nothing at all.
 * dismissed: the user closed the card for this domain in this tab (kept by the service worker, not the page).
 */
export interface PageReadyReply { report?: Report; paused?: boolean; dismissed?: boolean }
export interface FetchHtmlReply { ok: boolean; html?: string; status?: number; finalUrl?: string }
export interface AnalyzeReply { ok: boolean; report?: Report; error?: string }
export interface OkReply { ok: boolean; error?: string }
export interface TabState {
  status: TabStatus;
  report?: Report;
  fees?: FeeSummary;
  darkPatterns?: DarkPatternFinding[];
  pageType?: PageType;
  error?: string;
}

export interface Settings { enabled: boolean; apiBase: string; pausedDomains: string[] }
export const DEFAULT_SETTINGS: Settings = { enabled: true, apiBase: "http://localhost:8787", pausedDomains: [] };
export const REPORT_TTL_MS = 24 * 60 * 60 * 1000;
