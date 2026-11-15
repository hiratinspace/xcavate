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
  /**
   * `page` is the query-less address of the page the request was made for. It stays inside the
   * extension (late-reply check); only `request` is sent to the backend, whose pageUrl is origin + "/" (V-11).
   * `preliminary`: some policy pages are still loading; run the on-device rules over what arrived
   * (never sent anywhere) so the card shows a first verdict early. A full ANALYZE follows.
   */
  | ({ type: "ANALYZE" } & { request: AnalyzeRequest; page?: string; preliminary?: boolean })
  | { type: "LOCAL_FINDINGS"; fees?: FeeSummary; darkPatterns?: DarkPatternFinding[] }
  /**
   * bg → content. `page` is the query-less address the report was made for; the content script
   * drops a report for any other page (a late reply after the shopper moved on).
   */
  | { type: "REPORT"; report: Report; page: string }
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
  /**
   * Set when `report` was made on this device by the rules engine (V-06), never sent anywhere:
   * pending = the AI check is still running; unavailable = it failed, so this is the result;
   * off = the user turned the AI check off. Absent: the report came from the Xcavate service.
   */
  localCheck?: LocalCheck;
}

export type LocalCheck = "pending" | "unavailable" | "off";

/** aiCheck: send policy text to the Xcavate service for the AI pass (V-06). Off: nothing leaves the browser. */
export interface Settings { enabled: boolean; apiBase: string; pausedDomains: string[]; aiCheck: boolean }
export const DEFAULT_SETTINGS: Settings = { enabled: true, apiBase: "http://localhost:8787", pausedDomains: [], aiCheck: true };
export const REPORT_TTL_MS = 24 * 60 * 60 * 1000;
