import {
  MSG,
  domainOf,
  normalizeForHash,
  sha256Hex,
  stripPageUrl,
  type AnalyzeReply,
  type AnalyzeRequest,
  type FetchHtmlReply,
  type Message,
  type OkReply,
  type PageReadyReply,
  type Report,
  type TabState,
} from "@xcavate/shared";
import { runRulesOnly } from "@xcavate/shared/engine";
import { fetchCapped } from "../lib/fetchCapped";
import { isFetchAllowed } from "../lib/netguard";
import { buildAnalyzeRequest } from "../lib/request";
import { isActiveFor, loadSettings } from "../lib/settings";
import { lookupReport, postAnalyze } from "./api";
import { setBadge } from "./badge";
import {
  getCachedReport,
  getPolicyHash,
  getTab,
  isDismissed,
  patchTab,
  saveReport,
  setDismissed,
  setPolicyHash,
  setTab,
  type StoredTab,
} from "./state";

/** Service-worker message handlers (BUILD_PLAN 6.3), separated from listener wiring for tests. */

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createHandlers(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const now = deps.now ?? Date.now;
  /** In-flight de-duplication: one backend call per domain + policy set at a time. */
  const inflight = new Map<string, Promise<Report>>();

  async function notifyTab(tabId: number | undefined, msg: Message) {
    if (tabId === undefined || tabId < 0) return;
    try {
      await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      /* no content script there (yet) */
    }
  }

  /**
   * True while the tab still shows `pageUrl` (the page a request was made for). A reply that arrives
   * after the tab navigated elsewhere must not overwrite the new page's state or badge.
   */
  async function stillOn(tabId: number | undefined, pageUrl: string): Promise<boolean> {
    if (tabId === undefined) return false;
    const tab = await getTab(tabId);
    return !tab.pageUrl || tab.pageUrl === pageUrl;
  }

  /** Write tab state + badge only if the tab is still on `pageUrl`. */
  async function writeIfCurrent(tabId: number | undefined, pageUrl: string, patch: Partial<StoredTab>, report: Report | undefined) {
    if (tabId === undefined || !(await stillOn(tabId, pageUrl))) return;
    await patchTab(tabId, patch);
    await setBadge(tabId, report, patch.status ?? "idle");
  }

  async function pageReady(msg: Extract<Message, { type: "PAGE_READY" }>, tabId?: number): Promise<PageReadyReply> {
    const domain = domainOf(msg.url);
    const pageUrl = stripPageUrl(msg.url);
    const base = { domain, pageType: msg.pageType, pageUrl };
    const settings = await loadSettings();
    if (!isActiveFor(settings, domain)) {
      if (tabId !== undefined) await setTab(tabId, { status: "idle", ...base });
      await setBadge(tabId, undefined, "idle");
      return { paused: true };
    }
    if (msg.pageType === "none") {
      if (tabId !== undefined) await setTab(tabId, { status: "idle", ...base });
      await setBadge(tabId, undefined, "idle");
      return {};
    }
    const dismissed = tabId !== undefined && (await isDismissed(tabId, domain));
    const extra = dismissed ? { dismissed: true } : {};
    // AI check off: only the on-device verdict is used, and nothing (not even the domain) is sent.
    if (!settings.aiCheck) {
      if (tabId !== undefined) await setTab(tabId, { status: "checking", ...base });
      await setBadge(tabId, undefined, "checking");
      return { ...extra };
    }
    const cached = await getCachedReport(domain, now());
    if (cached) {
      if (tabId !== undefined) await setTab(tabId, { status: "ready", ...base });
      await setBadge(tabId, cached, "ready");
      return { report: cached, ...extra };
    }
    if (tabId !== undefined) await setTab(tabId, { status: "checking", ...base });
    await setBadge(tabId, undefined, "checking");
    // F-06 instant path: a shared report from the backend, shown at once; the content script
    // still sends ANALYZE, which refreshes it if the policy text changed.
    const remote = await lookupReport(settings.apiBase, domain, { fetchImpl });
    if (remote) {
      await saveReport(remote, now());
      await writeIfCurrent(tabId, pageUrl, { status: "ready" }, remote);
      return { report: remote, ...extra };
    }
    return { ...extra };
  }

  /** Same text as last time for every policy → the cached report still holds; no backend call. */
  function cacheStillValid(cached: Report, req: AnalyzeRequest, hashes: string[]): boolean {
    if (!req.policies.length) return false;
    return req.policies.every((p, i) => {
      const meta = cached.policies.find((m) => m.url === p.url);
      if (!p.text) return !meta || meta.status === "unreadable";
      return !!meta && meta.status === "analyzed" && meta.textHash === hashes[i];
    });
  }

  async function analyze(request: AnalyzeRequest, tabId?: number, page?: string): Promise<AnalyzeReply> {
    let domain: string;
    try {
      domain = domainOf(request.pageUrl);
    } catch {
      return { ok: false, error: "bad pageUrl" };
    }
    const settings = await loadSettings();
    if (!isActiveFor(settings, domain)) return { ok: false, error: "paused" };
    // The page the request was made for (local only); request.pageUrl is just origin + "/" (V-11).
    let pageUrl = stripPageUrl(request.pageUrl);
    if (page) {
      try {
        if (domainOf(page) === domain) pageUrl = stripPageUrl(page);
      } catch {
        /* keep request.pageUrl */
      }
    }

    const cleared = { localReport: undefined, localCheck: undefined };
    try {
      if (settings.aiCheck) {
        const hashes = await Promise.all(request.policies.map((p) => (p.text ? sha256Hex(normalizeForHash(p.text)) : "")));
        const cached = await getCachedReport(domain, now());
        if (cached && cacheStillValid(cached, request, hashes)) {
          await writeIfCurrent(tabId, pageUrl, { status: "ready", domain, error: undefined, ...cleared }, cached);
          return { ok: true, report: cached };
        }
      }

      // V-06: the rules engine on this device gives the first verdict at once, with no network.
      // It stays in tab state only; the backend's report (rules + AI) replaces it when it arrives.
      let local: Report | undefined;
      try {
        local = await runRulesOnly(buildAnalyzeRequest(request));
      } catch {
        local = undefined;
      }

      if (!settings.aiCheck) {
        if (!local) throw new Error("local check failed");
        await writeIfCurrent(tabId, pageUrl, { status: "ready", domain, error: undefined, localReport: local, localCheck: "off" }, local);
        return { ok: true, report: local };
      }

      if (tabId !== undefined && (await stillOn(tabId, pageUrl))) {
        if (local) {
          // Status stays "checking" (the popup keeps polling) while the badge already shows the verdict.
          await writeIfCurrent(tabId, pageUrl, { status: "checking", domain, error: undefined, localReport: local, localCheck: "pending" }, local);
          await notifyTab(tabId, { type: MSG.REPORT, report: local });
        } else await patchTab(tabId, { status: "checking", domain, error: undefined, ...cleared });
      }

      let report: Report;
      try {
        report = await backendReport(request, domain, settings.apiBase);
      } catch (e) {
        if (!local) throw e;
        // Backend down or invalid: the on-device verdict is the result, not an error.
        await writeIfCurrent(tabId, pageUrl, { status: "ready", domain, error: undefined, localReport: local, localCheck: "unavailable" }, local);
        return { ok: true, report: local };
      }
      await writeIfCurrent(tabId, pageUrl, { status: "ready", domain, ...cleared }, report);
      return { ok: true, report };
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      if (await stillOn(tabId, pageUrl)) {
        await writeIfCurrent(tabId, pageUrl, { status: "error", domain, error, ...cleared }, undefined);
        await notifyTab(tabId, { type: MSG.STATUS, status: "error" });
      }
      return { ok: false, error };
    }
  }

  /** One backend call per domain + policy set at a time (a manual scan never borrows a checkout's result). */
  function backendReport(request: AnalyzeRequest, domain: string, apiBase: string): Promise<Report> {
    const flightKey = domain + "|" + request.policies.map((x) => x.url).join(" ");
    let p = inflight.get(flightKey);
    if (!p) {
      p = (async () => {
        const withHashes = await Promise.all(
          request.policies.map(async (pol) => ({ ...pol, previousHash: (await getPolicyHash(pol.url)) ?? undefined })),
        );
        const body = buildAnalyzeRequest({ ...request, policies: withHashes });
        const report = await postAnalyze(apiBase, body, { fetchImpl });
        await saveReport(report, now());
        for (const m of report.policies) if (m.status === "analyzed" && m.textHash) await setPolicyHash(m.url, m.textHash);
        return report;
      })();
      inflight.set(flightKey, p);
      p.finally(() => inflight.delete(flightKey)).catch(() => undefined);
    }
    return p;
  }

  async function localFindings(msg: Extract<Message, { type: "LOCAL_FINDINGS" }>, tabId?: number): Promise<OkReply> {
    // Stored for the popup only. Never sent to the backend.
    if (tabId !== undefined) await patchTab(tabId, { fees: msg.fees, darkPatterns: msg.darkPatterns });
    return { ok: true };
  }

  /** Only for a content script in a tab, and never into the local network unless that tab is local too. */
  async function fetchHtml(url: string, tabUrl: string | undefined): Promise<FetchHtmlReply> {
    if (!tabUrl || !isFetchAllowed(url, tabUrl)) return { ok: false };
    const r = await fetchCapped(url, { fetchImpl, allow: (u) => isFetchAllowed(u, tabUrl) });
    return { ok: r.ok, html: r.html, status: r.status, finalUrl: r.finalUrl };
  }

  async function getState(tabId: number): Promise<TabState> {
    const tab = await getTab(tabId);
    const local = tab.status !== "idle" && tab.status !== "error" ? tab.localReport : undefined;
    const report = local ?? (tab.domain && tab.status !== "idle" ? await getCachedReport(tab.domain, now()) : undefined);
    const state: TabState = { status: tab.status, report, fees: tab.fees, darkPatterns: tab.darkPatterns, pageType: tab.pageType, error: tab.error };
    if (local && tab.localCheck) state.localCheck = tab.localCheck;
    return state;
  }

  async function scanTab(tabId: number): Promise<OkReply> {
    const msg: Message = { type: MSG.SCAN_CURRENT_PAGE };
    let reply: OkReply | undefined;
    try {
      reply = (await chrome.tabs.sendMessage(tabId, msg)) as OkReply | undefined;
    } catch {
      // Tab opened before the extension was installed or reloaded: inject the content script, retry.
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        reply = (await chrome.tabs.sendMessage(tabId, msg)) as OkReply | undefined;
      } catch (e) {
        return { ok: false, error: "Can't scan this page: " + String((e as Error)?.message ?? e) };
      }
    }
    // The content script refuses to scan checkout pages (their text holds the shopper's details).
    if (reply && reply.ok === false) return { ok: false, error: reply.error ?? "Couldn't scan this page." };
    await patchTab(tabId, { status: "checking", error: undefined });
    await setBadge(tabId, undefined, "checking");
    return { ok: true };
  }

  async function handle(msg: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
    const tabId = sender.tab?.id;
    switch (msg?.type) {
      case MSG.PING:
        return { ok: true };
      case MSG.PAGE_READY:
        return pageReady(msg, tabId);
      case MSG.ANALYZE:
        return analyze(msg.request, tabId, msg.page);
      case MSG.LOCAL_FINDINGS:
        return localFindings(msg, tabId);
      case MSG.FETCH_HTML:
        return fetchHtml(msg.url, sender.tab?.url);
      case MSG.STATUS:
        // content → bg: the run failed after PAGE_READY; leave "checking" so the badge isn't stuck.
        if (tabId !== undefined && msg.status === "error" && (await getTab(tabId)).status === "checking") {
          await patchTab(tabId, { status: "error", error: "page check failed" });
          await setBadge(tabId, undefined, "error");
        }
        return { ok: true };
      case MSG.SET_DISMISSED: {
        const url = sender.tab?.url;
        if (tabId === undefined || !url) return { ok: false };
        try {
          await setDismissed(tabId, domainOf(url), msg.dismissed);
        } catch {
          return { ok: false };
        }
        return { ok: true };
      }
      case MSG.GET_STATE:
        return getState(msg.tabId);
      case MSG.SCAN_TAB:
        return scanTab(msg.tabId);
      default:
        return undefined;
    }
  }

  return { handle, pageReady, analyze, localFindings, fetchHtml, getState, scanTab };
}
