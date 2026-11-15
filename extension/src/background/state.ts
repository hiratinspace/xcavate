import { REPORT_TTL_MS, type DarkPatternFinding, type WatcherFinding, type LocalCheck, type FeeSummary, type PageType, type Report, type TabStatus } from "@xcavate/shared";

/**
 * Storage owned by the service worker (BUILD_PLAN 6.4).
 *   local   report:<domain>    { report, savedAt }   24 h
 *   local   hash:<policyUrl>   last seen textHash     forever
 *   local   settings           see lib/settings.ts
 *   session tab:<tabId>        StoredTab              browser session
 */

export interface StoredTab {
  status: TabStatus;
  /** Query-less URL of the page this state belongs to; a late reply for another page is dropped. */
  pageUrl?: string;
  domain?: string;
  pageType?: PageType;
  fees?: FeeSummary;
  darkPatterns?: DarkPatternFinding[];
  watchers?: WatcherFinding[];
  error?: string;
  /**
   * V-06: the on-device rules-only report for this page. It lives only in tab state (never in the
   * per-domain report cache, so it can never stop the AI check from running next time).
   */
  localReport?: Report;
  /** How far the AI check got for `localReport` (see TabState.localCheck). */
  localCheck?: LocalCheck;
  /** A manual scan ("Scan this page") is running; a re-injected content script's PAGE_READY must not end it. */
  scanning?: boolean;
  /** When the tab entered "checking" (ms); a check that never finished is closed on read. */
  checkingSince?: number;
  /** Id of the worker instance that set "checking"; another id means that worker was stopped mid-check. */
  owner?: string;
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

/** Policy URLs are stored without query or hash (they can carry session ids). */
function policyKey(url: string): string {
  try {
    const u = new URL(url);
    return hashKey(u.origin + u.pathname);
  } catch {
    return hashKey(url);
  }
}

export const MAX_POLICY_HASHES = 500;
const HASH_INDEX = "hashIndex";

export async function getPolicyHash(url: string): Promise<string | undefined> {
  const key = policyKey(url);
  const got = await chrome.storage.local.get(key);
  const h = got?.[key];
  return typeof h === "string" ? h : undefined;
}

/** Remember a policy's last textHash; keeps the newest MAX_POLICY_HASHES and evicts the oldest. */
export async function setPolicyHash(url: string, hash: string): Promise<void> {
  const key = policyKey(url);
  const got = await chrome.storage.local.get(HASH_INDEX);
  const index = (Array.isArray(got?.[HASH_INDEX]) ? (got[HASH_INDEX] as string[]) : []).filter((k) => k !== key);
  index.push(key);
  const evict = index.length > MAX_POLICY_HASHES ? index.splice(0, index.length - MAX_POLICY_HASHES) : [];
  await chrome.storage.local.set({ [key]: hash, [HASH_INDEX]: index });
  if (evict.length) await chrome.storage.local.remove(evict);
}

const dismissKey = (tabId: number) => "dismiss:" + tabId;

/** Domains whose card the user closed in this tab (chrome.storage.session, out of the page's reach). */
export async function isDismissed(tabId: number, domain: string): Promise<boolean> {
  const list = await sessionGet<string[]>(dismissKey(tabId));
  return Array.isArray(list) && list.includes(domain);
}

export async function setDismissed(tabId: number, domain: string, dismissed: boolean): Promise<void> {
  const list = new Set((await sessionGet<string[]>(dismissKey(tabId))) ?? []);
  if (dismissed) list.add(domain);
  else list.delete(domain);
  await sessionSet(dismissKey(tabId), Array.from(list));
}

async function sessionGet<T>(key: string): Promise<T | undefined> {
  const area = session();
  return (area ? (await area.get(key))?.[key] : memorySession.get(key)) as T | undefined;
}

async function sessionSet(key: string, value: unknown): Promise<void> {
  const area = session();
  if (area) await area.set({ [key]: value });
  else memorySession.set(key, value);
}

/**
 * Per-tab write queue. Every read-modify-write of a tab's state runs here one after the other,
 * so two handlers (LOCAL_FINDINGS and the final "ready" write, say) can't both read the old value
 * and lose each other's fields. Plain getTab reads are not queued.
 */
const tabQueues = new Map<number, Promise<unknown>>();

export function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = tabQueues.get(tabId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  tabQueues.set(tabId, tail);
  void tail.then(() => {
    if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
  });
  return run;
}

/**
 * Atomic update: `fn` gets the current state and returns the next one, or undefined to leave it
 * unchanged. Resolves to the state written (or undefined when nothing was written).
 */
export function updateTab(
  tabId: number,
  fn: (cur: StoredTab) => StoredTab | undefined | Promise<StoredTab | undefined>,
): Promise<StoredTab | undefined> {
  return withTabLock(tabId, async () => {
    const next = await fn(await getTab(tabId));
    if (next) await writeTab(tabId, next);
    return next;
  });
}

export async function getTab(tabId: number): Promise<StoredTab> {
  const key = tabKey(tabId);
  const area = session();
  const v = area ? (await area.get(key))?.[key] : memorySession.get(key);
  return (v as StoredTab | undefined) ?? { status: "idle" };
}

async function writeTab(tabId: number, value: StoredTab): Promise<void> {
  const key = tabKey(tabId);
  const area = session();
  if (area) await area.set({ [key]: value });
  else memorySession.set(key, value);
}

export function setTab(tabId: number, value: StoredTab): Promise<void> {
  return withTabLock(tabId, () => writeTab(tabId, value));
}

export async function patchTab(tabId: number, patch: Partial<StoredTab>): Promise<StoredTab> {
  return (await updateTab(tabId, (cur) => ({ ...cur, ...patch })))!;
}

export function clearTab(tabId: number): Promise<void> {
  return withTabLock(tabId, async () => {
    const keys = [tabKey(tabId), dismissKey(tabId)];
    const area = session();
    if (area) await area.remove(keys);
    else keys.forEach((k) => memorySession.delete(k));
  });
}
