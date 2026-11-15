import { REPORT_TTL_MS, type DarkPatternFinding, type FeeSummary, type PageType, type Report, type TabStatus } from "@xcavate/shared";

/**
 * Storage owned by the service worker (BUILD_PLAN 6.4).
 *   local   report:<domain>    { report, savedAt }   24 h
 *   local   hash:<policyUrl>   last seen textHash     forever
 *   local   settings           see lib/settings.ts
 *   session tab:<tabId>        StoredTab              browser session
 */

export interface StoredTab {
  status: TabStatus;
  domain?: string;
  pageType?: PageType;
  fees?: FeeSummary;
  darkPatterns?: DarkPatternFinding[];
  error?: string;
}

const reportKey = (domain: string) => "report:" + domain;
const hashKey = (url: string) => "hash:" + url;
const tabKey = (tabId: number) => "tab:" + tabId;

/** chrome.storage.session exists in Chrome 102+; fall back to an in-memory map just in case. */
const memorySession = new Map<string, unknown>();
function session(): chrome.storage.StorageArea | undefined {
  return chrome.storage?.session;
}

export async function getCachedReport(domain: string, now = Date.now()): Promise<Report | undefined> {
  const key = reportKey(domain);
  const got = await chrome.storage.local.get(key);
  const entry = got?.[key] as { report: Report; savedAt: number } | undefined;
  if (!entry?.report || typeof entry.savedAt !== "number") return undefined;
  if (now - entry.savedAt > REPORT_TTL_MS) {
    await chrome.storage.local.remove(key);
    return undefined;
  }
  return entry.report;
}

export async function saveReport(report: Report, now = Date.now()): Promise<void> {
  await chrome.storage.local.set({ [reportKey(report.domain)]: { report, savedAt: now } });
}

export async function getPolicyHash(url: string): Promise<string | undefined> {
  const got = await chrome.storage.local.get(hashKey(url));
  const h = got?.[hashKey(url)];
  return typeof h === "string" ? h : undefined;
}

export async function setPolicyHash(url: string, hash: string): Promise<void> {
  await chrome.storage.local.set({ [hashKey(url)]: hash });
}

export async function getTab(tabId: number): Promise<StoredTab> {
  const key = tabKey(tabId);
  const area = session();
  const v = area ? (await area.get(key))?.[key] : memorySession.get(key);
  return (v as StoredTab | undefined) ?? { status: "idle" };
}

export async function setTab(tabId: number, value: StoredTab): Promise<void> {
  const key = tabKey(tabId);
  const area = session();
  if (area) await area.set({ [key]: value });
  else memorySession.set(key, value);
}

export async function patchTab(tabId: number, patch: Partial<StoredTab>): Promise<StoredTab> {
  const next = { ...(await getTab(tabId)), ...patch };
  await setTab(tabId, next);
  return next;
}

export async function clearTab(tabId: number): Promise<void> {
  const key = tabKey(tabId);
  const area = session();
  if (area) await area.remove(key);
  else memorySession.delete(key);
}
