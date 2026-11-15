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
  type LocalFindingsReply,
  type PageReadyReply,
  type Report,
  type Settings,
  type TabState,
  type TabStatus,
} from "@xcavate/shared";
import { runRulesOnly } from "@xcavate/shared/engine";
import { fetchCapped } from "../lib/fetchCapped";
import { isFetchAllowed } from "../lib/netguard";
import { buildAnalyzeRequest } from "../lib/request";
import { isActiveFor, loadSettings } from "../lib/settings";
import { matchWatchers } from "../lib/watchers";
import { fetchProvider, lookupReport, postAnalyze } from "./api";
import { setBadge } from "./badge";
import {
  getCachedReport,
  getPolicyHash,
  getTab,
  isDismissed,
  saveReport,
  setDismissed,
  setPolicyHash,
  updateTab,
  type StoredTab,
} from "./state";

/** Service-worker message handlers (BUILD_PLAN 6.3), separated from listener wiring for tests. */

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** How long the service's provider answer (/healthz) is trusted. */
export const PROVIDER_TTL_MS = 10 * 60 * 1000;
/** A "checking" state older than this, left by a worker that is gone, is closed on read. */
export const STALE_CHECKING_MS = 45_000;

/** Thrown when the user turned the AI check off while a backend call was running. */
class AiCheckOff extends Error {
  constructor() {
    super("AI check turned off");
  }
}

/** Origin + path of a URL, or undefined for anything that is not http(s). */
function pageKeyOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return stripPageUrl(u.href);
  } catch {
    return undefined;
  }
}

/** Stored pageUrl for a tab that left the web (chrome://, a PDF viewer we can't see, a closed page). */
const ELSEWHERE = "elsewhere:";

export function createHandlers(deps: Deps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const now = deps.now ?? Date.now;
  /** Identifies this worker instance; "checking" left by an earlier (stopped) worker is stale. */
  const workerId = Math.random().toString(36).slice(2) + now().toString(36);
  /** In-flight de-duplication: one backend call per domain + policy set at a time. */
  const inflight = new Map<string, Promise<{ report: Report; complete: boolean }>>();
  /** Tabs with an analyze() running in this worker. */
  const active = new Map<number, number>();
  /** Aborted (and replaced) when the user turns the AI check off: every backend call listens to it. */
  let aiCtrl = new AbortController();
  let provider: { apiBase: string; value: string; at: number } | undefined;

  async function notifyTab(tabId: number | undefined, msg: Message) {
    if (tabId === undefined || tabId < 0) return;
    try {
      await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      /* no content script there (yet) */
    }
  }

  /** The tab's live URL still shows `pageUrl`. Unknown (no tabs API, as in tests) counts as yes. */
  async function liveOn(tabId: number, pageUrl: string): Promise<boolean> {
    if (typeof chrome.tabs?.get !== "function") return true;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return true;
      // We hold host permissions for every http(s) page, so a missing URL means the tab left the web.
      return pageKeyOf(tab.url) === pageUrl;
    } catch {
      return false; // tab closed
    }
  }

  function onPage(cur: StoredTab, pageUrl: string): boolean {
    return !cur.pageUrl || cur.pageUrl === pageUrl;
  }

  /** Marks a state as "checking" owned by this worker (see getState's stale check). */
  function checking(cur: StoredTab, patch: Partial<StoredTab>): StoredTab {
    const since = cur.status === "checking" && cur.checkingSince ? cur.checkingSince : now();
    return { ...cur, ...patch, status: "checking", owner: workerId, checkingSince: since };
  }

  function settled(cur: StoredTab, patch: Partial<StoredTab> & { status: TabStatus }): StoredTab {
    return { ...cur, ...patch, owner: undefined, checkingSince: undefined, scanning: undefined };
  }

  /**
   * Atomically: if the tab still shows `pageUrl` (stored and live) and `when` holds, write
   * `make(cur)` and the badge for `report`. Returns whether it wrote.
   */
  async function writeIfCurrent(
    tabId: number | undefined,
    pageUrl: string,
    make: (cur: StoredTab) => StoredTab,
    report: Report | undefined,
    when: (cur: StoredTab) => boolean = () => true,
  ): Promise<boolean> {
    if (tabId === undefined) return false;
    let wrote = false;
    await updateTab(tabId, async (cur) => {
      if (!onPage(cur, pageUrl) || !when(cur) || !(await liveOn(tabId, pageUrl))) return undefined;
      const next = make(cur);
      wrote = true;
      await setBadge(tabId, report, next.status);
      return next;
    });
    return wrote;
  }

  /** True when the service answers that it is the rules engine on purpose (mock mode). Cached. */
  async function serviceIsRulesOnly(apiBase: string, signal?: AbortSignal): Promise<boolean> {
    if (provider && provider.apiBase === apiBase && now() - provider.at < PROVIDER_TTL_MS) return provider.value === "mock";
    const value = await fetchProvider(apiBase, { fetchImpl, signal });
    if (value !== undefined) provider = { apiBase, value, at: now() };
    return value === "mock";
  }

  /**
   * A report is complete (cacheable for 24 h, shown without the "AI check unavailable" note) when the
   * AI pass ran, there was nothing for it to read, or the service runs no model by design.
   * A rules-only answer from a model-backed service means the model timed out or failed.
   */
  async function isComplete(report: Report, apiBase: string, signal?: AbortSignal): Promise<boolean> {
    if (report.stats.usedLlm) return true;
    if (!report.policies.some((p) => p.status === "analyzed")) return true;
    return serviceIsRulesOnly(apiBase, signal);
  }

  async function aiStillOn(): Promise<boolean> {
    return (await loadSettings()).aiCheck && !aiCtrl.signal.aborted;
  }

  async function pageReady(msg: Extract<Message, { type: "PAGE_READY" }>, tabId?: number): Promise<PageReadyReply> {
    const domain = domainOf(msg.url);
    const pageUrl = stripPageUrl(msg.url);
    const base = { domain, pageType: msg.pageType, pageUrl };
    const settings = await loadSettings();
    const idle = async () => {
      if (tabId === undefined) return;
      await updateTab(tabId, async (cur) => {
        // A manual scan of this very page is running (its content script was just injected).
        if (cur.scanning && cur.status === "checking" && cur.pageUrl === pageUrl && cur.owner === workerId) return undefined;
        await setBadge(tabId, undefined, "idle");
        return { status: "idle", ...base };
      });
    };
    if (!isActiveFor(settings, domain)) {
      await idle();
      return { paused: true };
    }
    if (msg.pageType === "none") {
      await idle();
      return {};
    }
    const dismissed = tabId !== undefined && (await isDismissed(tabId, domain));
    const extra = dismissed ? { dismissed: true } : {};
    const startChecking = async () => {
      if (tabId === undefined) return;
      await updateTab(tabId, async () => {
        await setBadge(tabId, undefined, "checking");
        return checking({ status: "idle" }, base);
      });
    };
    // AI check off: only the on-device verdict is used, and nothing (not even the domain) is sent.
    if (!settings.aiCheck) {
      await startChecking();
      return { ...extra };
    }
    const cached = await getCachedReport(domain, now());
    if (cached) {
      if (tabId !== undefined) {
        await updateTab(tabId, async () => {
          await setBadge(tabId, cached, "ready");
          return { status: "ready", ...base };
        });
      }
      return { report: cached, ...extra };
    }
    await startChecking();
    // F-06 instant path, without holding up the card: a shared report from the backend is pushed
    // to the tab when it arrives. The content script still sends ANALYZE, which refreshes it.
    const signal = aiCtrl.signal;
    void (async () => {
      const remote = await lookupReport(settings.apiBase, domain, { fetchImpl, signal });
      if (!remote || signal.aborted || !(await isComplete(remote, settings.apiBase, signal))) return;
      if (!(await aiStillOn())) return;
      await saveReport(remote, now());
      const wrote = await writeIfCurrent(
        tabId,
        pageUrl,
        (cur) => settled(cur, { status: "ready", domain, error: undefined }),
        remote,
        // Only while nothing better is on the way: no on-device verdict yet, still checking.
        (cur) => cur.status === "checking" && !cur.localReport,
      );
      if (wrote) await notifyTab(tabId, { type: MSG.REPORT, report: remote, page: pageUrl });
    })().catch(() => undefined);
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

  async function analyze(request: AnalyzeRequest, tabId?: number, page?: string, preliminary = false): Promise<AnalyzeReply> {
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

    if (preliminary) return analyzePreliminary(request, tabId, pageUrl, domain, settings);
    if (tabId !== undefined) active.set(tabId, (active.get(tabId) ?? 0) + 1);
    try {
      return await analyzeFull(request, tabId, pageUrl, domain, settings);
    } finally {
      if (tabId !== undefined) {
        const n = (active.get(tabId) ?? 1) - 1;
        if (n > 0) active.set(tabId, n);
        else active.delete(tabId);
      }
    }
  }

  /** Some policy pages are still loading: an early on-device verdict from what arrived. Never sent anywhere. */
  async function analyzePreliminary(request: AnalyzeRequest, tabId: number | undefined, pageUrl: string, domain: string, settings: Settings): Promise<AnalyzeReply> {
    let local: Report;
    try {
      local = await runRulesOnly(buildAnalyzeRequest(request));
    } catch {
      return { ok: false, error: "local check failed" };
    }
    await writeIfCurrent(
      tabId,
      pageUrl,
      (cur) => checking(cur, { domain, error: undefined, localReport: local, localCheck: settings.aiCheck ? "pending" : "off" }),
      local,
      // Never over a result or a fuller on-device verdict.
      (cur) => cur.status === "checking" && !cur.localReport,
    );
    return { ok: true, report: local };
  }

  async function analyzeFull(request: AnalyzeRequest, tabId: number | undefined, pageUrl: string, domain: string, settings: Settings): Promise<AnalyzeReply> {
    const cleared = { localReport: undefined, localCheck: undefined };
    const apiBase = settings.apiBase;
    try {
      if (settings.aiCheck) {
        const hashes = await Promise.all(request.policies.map((p) => (p.text ? sha256Hex(normalizeForHash(p.text)) : "")));
        const cached = await getCachedReport(domain, now());
        if (cached && cacheStillValid(cached, request, hashes) && (await isComplete(cached, apiBase, aiCtrl.signal))) {
          await writeIfCurrent(tabId, pageUrl, (cur) => settled(cur, { status: "ready", domain, error: undefined, ...cleared }), cached);
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

      const localResult = async (localCheck: "off" | "unavailable") => {
        await writeIfCurrent(tabId, pageUrl, (cur) => settled(cur, { status: "ready", domain, error: undefined, localReport: local, localCheck }), local);
        return { ok: true, report: local } as AnalyzeReply;
      };

      if (!settings.aiCheck || !(await aiStillOn())) {
        if (!local) throw new Error("local check failed");
        return localResult("off");
      }

      if (local) {
        // Status stays "checking" (the popup keeps polling) while the badge already shows the verdict.
        const wrote = await writeIfCurrent(tabId, pageUrl, (cur) => checking(cur, { domain, error: undefined, localReport: local, localCheck: "pending" }), local);
        if (wrote) await notifyTab(tabId, { type: MSG.REPORT, report: local, page: pageUrl });
      } else {
        await writeIfCurrent(tabId, pageUrl, (cur) => checking(cur, { domain, error: undefined, ...cleared }), undefined);
      }

      let result: { report: Report; complete: boolean };
      try {
        result = await backendReport(request, domain, apiBase);
      } catch (e) {
        // The user turned the AI check off meanwhile: the on-device verdict is the result.
        if (e instanceof AiCheckOff || !(await loadSettings()).aiCheck) {
          if (!local) throw new Error("local check failed");
          return localResult("off");
        }
        if (!local) throw e;
        // Backend down or invalid: the on-device verdict is the result, not an error.
        return localResult("unavailable");
      }
      const { report, complete } = result;
      if (complete) {
        await writeIfCurrent(tabId, pageUrl, (cur) => settled(cur, { status: "ready", domain, error: undefined, ...cleared }), report);
      } else {
        // The model timed out or failed and the service answered with its rules only. Show it, say so,
        // and keep it out of the 24 h cache so the next visit asks the AI again.
        await writeIfCurrent(tabId, pageUrl, (cur) => settled(cur, { status: "ready", domain, error: undefined, localReport: report, localCheck: "unavailable" }), report);
      }
      return { ok: true, report };
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      const wrote = await writeIfCurrent(tabId, pageUrl, (cur) => settled(cur, { status: "error", domain, error, ...cleared }), undefined);
      if (wrote) await notifyTab(tabId, { type: MSG.STATUS, status: "error" });
      return { ok: false, error };
    }
  }

  /** One backend call per domain + policy set at a time (a manual scan never borrows a checkout's result). */
  function backendReport(request: AnalyzeRequest, domain: string, apiBase: string): Promise<{ report: Report; complete: boolean }> {
    const flightKey = apiBase + "|" + domain + "|" + request.policies.map((x) => x.url).join(" ");
    let p = inflight.get(flightKey);
    if (!p) {
      const signal = aiCtrl.signal;
      p = (async () => {
        const withHashes = await Promise.all(
          request.policies.map(async (pol) => ({ ...pol, previousHash: (await getPolicyHash(pol.url)) ?? undefined })),
        );
        const body = buildAnalyzeRequest({ ...request, policies: withHashes });
        // Last check before anything leaves the browser: the setting may have changed meanwhile.
        if (signal.aborted || !(await loadSettings()).aiCheck) throw new AiCheckOff();
        let report: Report;
        try {
          report = await postAnalyze(apiBase, body, { fetchImpl, signal });
        } catch (e) {
          if (signal.aborted) throw new AiCheckOff();
          throw e;
        }
        const complete = await isComplete(report, apiBase, signal);
        if (signal.aborted) throw new AiCheckOff();
        if (complete) await saveReport(report, now());
        for (const m of report.policies) if (m.status === "analyzed" && m.textHash) await setPolicyHash(m.url, m.textHash);
        return { report, complete };
      })();
      inflight.set(flightKey, p);
      p.finally(() => inflight.delete(flightKey)).catch(() => undefined);
    }
    return p;
  }

  /** chrome.storage.onChanged: turning the AI check off cancels every backend call in flight. */
  function settingsChanged(next: Partial<Settings> | undefined, prev?: Partial<Settings>): void {
    if (next?.aiCheck === false && prev?.aiCheck !== false) {
      aiCtrl.abort();
      aiCtrl = new AbortController();
    }
  }

  async function localFindings(msg: Extract<Message, { type: "LOCAL_FINDINGS" }>, tabId?: number): Promise<LocalFindingsReply> {
    // Stored for the popup only. Never sent to the backend.
    const watchers = matchWatchers(Array.isArray(msg.thirdParty) ? msg.thirdParty.slice(0, 300) : []);
    if (tabId !== undefined) await updateTab(tabId, (cur) => ({ ...cur, fees: msg.fees, darkPatterns: msg.darkPatterns, watchers }));
    return { ok: true, watchers };
  }

  /** Only for a content script in a tab, and never into the local network unless that tab is local too. */
  async function fetchHtml(url: string, tabUrl: string | undefined): Promise<FetchHtmlReply> {
    if (!tabUrl || !isFetchAllowed(url, tabUrl)) return { ok: false };
    const r = await fetchCapped(url, { fetchImpl, allow: (u) => isFetchAllowed(u, tabUrl) });
    return { ok: r.ok, html: r.html, status: r.status, finalUrl: r.finalUrl };
  }

  /** content → bg: the run failed or lost its worker after PAGE_READY. Close "checking" with what we have. */
  async function contentStatus(status: TabStatus, tabId?: number): Promise<OkReply> {
    if (tabId === undefined || status !== "error") return { ok: true };
    await updateTab(tabId, async (cur) => {
      if (cur.status !== "checking") return undefined;
      const next = cur.localReport
        ? settled(cur, { status: "ready", localCheck: cur.localCheck === "off" ? "off" : "unavailable" })
        : settled(cur, { status: "error", error: "page check failed" });
      await setBadge(tabId, next.localReport, next.status);
      return next;
    });
    return { ok: true };
  }

  /** A "checking" state whose worker is gone (Chrome stopped it mid-analysis) is finished here. */
  function isStale(tab: StoredTab, tabId: number): boolean {
    if (tab.status !== "checking" || active.has(tabId) || tab.owner === workerId) return false;
    if (tab.localReport && tab.localCheck === "pending") return true;
    return tab.checkingSince === undefined || now() - tab.checkingSince > STALE_CHECKING_MS;
  }

  async function getState(tabId: number): Promise<TabState> {
    let tab = await getTab(tabId);
    if (isStale(tab, tabId)) {
      tab =
        (await updateTab(tabId, async (cur) => {
          if (!isStale(cur, tabId)) return undefined;
          const next = cur.localReport
            ? settled(cur, { status: "ready", localCheck: cur.localCheck === "off" ? "off" : "unavailable" })
            : settled(cur, { status: "error", error: "page check did not finish" });
          await setBadge(tabId, next.localReport, next.status);
          return next;
        })) ?? (await getTab(tabId));
    }
    const local = tab.status !== "idle" && tab.status !== "error" ? tab.localReport : undefined;
    const report = local ?? (tab.domain && tab.status !== "idle" ? await getCachedReport(tab.domain, now()) : undefined);
    const state: TabState = { status: tab.status, report, fees: tab.fees, darkPatterns: tab.darkPatterns, watchers: tab.watchers, pageType: tab.pageType, error: tab.error };
    if (local && tab.localCheck) state.localCheck = tab.localCheck;
    return state;
  }

  async function scanTab(tabId: number): Promise<OkReply> {
    const msg: Message = { type: MSG.SCAN_CURRENT_PAGE };
    // "checking" first: with the AI check off the on-device result can land before sendMessage returns.
    let before: StoredTab | undefined;
    await updateTab(tabId, async (cur) => {
      before = cur;
      await setBadge(tabId, undefined, "checking");
      return checking(cur, { error: undefined, scanning: true });
    });
    const undo = async (error: string): Promise<OkReply> => {
      await updateTab(tabId, async (cur) => {
        if (!(cur.status === "checking" && cur.scanning && cur.owner === workerId)) return undefined;
        const prev = before ?? { status: "idle" as const };
        await setBadge(tabId, prev.status === "idle" || prev.status === "error" ? undefined : (prev.localReport ?? (prev.domain ? await getCachedReport(prev.domain, now()) : undefined)), prev.status);
        return prev;
      });
      return { ok: false, error };
    };
    let reply: OkReply | undefined;
    try {
      reply = (await chrome.tabs.sendMessage(tabId, msg)) as OkReply | undefined;
    } catch {
      // Tab opened before the extension was installed or reloaded: inject the content script, retry.
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        reply = (await chrome.tabs.sendMessage(tabId, msg)) as OkReply | undefined;
      } catch (e) {
        return undo("Can't scan this page: " + String((e as Error)?.message ?? e));
      }
    }
    // The content script refuses to scan checkout pages (their text holds the shopper's details).
    if (reply && reply.ok === false) return undo(reply.error ?? "Couldn't scan this page.");
    return { ok: true };
  }

  /**
   * chrome.tabs.onUpdated: a navigation to another page (origin + path) ends this tab's state, so a
   * late reply for the old page can't land, and pages that never send PAGE_READY (PDFs, chrome://)
   * don't keep the old badge.
   */
  async function tabUpdated(tabId: number, info: { url?: string; status?: string }, tabUrl?: string): Promise<void> {
    if (info.url === undefined && info.status !== "loading") return;
    const key = pageKeyOf(info.url ?? tabUrl) ?? ELSEWHERE;
    await updateTab(tabId, async (cur) => {
      if (cur.pageUrl === key || (!cur.pageUrl && cur.status === "idle")) return undefined;
      await setBadge(tabId, undefined, "idle");
      return { status: "idle", pageUrl: key };
    });
  }

  async function handle(msg: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
    const tabId = sender.tab?.id;
    switch (msg?.type) {
      case MSG.PING:
        return { ok: true };
      case MSG.PAGE_READY:
        return pageReady(msg, tabId);
      case MSG.ANALYZE:
        return analyze(msg.request, tabId, msg.page, msg.preliminary === true);
      case MSG.LOCAL_FINDINGS:
        return localFindings(msg, tabId);
      case MSG.FETCH_HTML:
        return fetchHtml(msg.url, sender.tab?.url);
      case MSG.STATUS:
        return contentStatus(msg.status, tabId);
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

  return { handle, pageReady, analyze, localFindings, fetchHtml, getState, scanTab, tabUpdated, settingsChanged };
}
