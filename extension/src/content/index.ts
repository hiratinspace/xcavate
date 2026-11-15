import {
  MSG,
  domainOf,
  stripPageUrl,
  type AnalyzeReply,
  type Message,
  type PageReadyReply,
  type PageType,
} from "@xcavate/shared/core";
import type { DarkPatternFinding, LocalFindingsReply, WatcherFinding } from "@xcavate/shared/core";
import { send } from "../lib/messaging";
import { buildAnalyzeRequest } from "../lib/request";
import { CARD_HOST_ID, Card, type CardPrefs } from "./card";
import { classify, watchForLateQualify } from "./classifier";
import { collectPolicies, waitForDomQuiet, type FetchedPage } from "./collect";
import { DarkPatternMarkers, MARKS_HOST_ID, findDarkPatterns } from "./darkPatterns";
import { thirdPartyAddresses, watchAddresses } from "./watchers";
import { extractLiveDocument } from "./extractor";
import { detectFees } from "./fees";
import { watchNavigation } from "./spa";

/** Card layout preference (expanded, corner) in chrome.storage.local. */
const CARD_PREFS_KEY = "cardPrefs";

/**
 * D-06 content orchestrator: classify → PAGE_READY → find → fetch → ANALYZE → card.
 * Nothing here clicks, fills, submits or blocks anything, and nothing reads form values.
 */

declare global {
  interface Window {
    __xcavateLoaded?: boolean;
  }
}

/** No result after this long, but some policy pages arrived: show an on-device verdict from those. */
export const EARLY_VERDICT_MS = 3_000;

export const SCAN_REFUSED =
  "This looks like a checkout page, so Xcavate won't send its text (it can hold your name, address and order). Open the policy page itself and scan there.";

export function startContent(win: Window = window): void {
  if (win.__xcavateLoaded) return;
  win.__xcavateLoaded = true;
  const doc = win.document;
  // Dismissal lives in the service worker (per tab + domain), not in page storage the shop could edit.
  let dismissed = false;
  const card = new Card(doc, {
    onDismiss: () => {
      dismissed = true;
      void send({ type: MSG.SET_DISMISSED, dismissed: true });
    },
    // Expanded/collapsed and corner are the shopper's choice: kept in extension storage (never page
    // storage the shop could read or edit) so they survive reloads and other sites.
    onPrefsChange: (prefs) => {
      void chrome.storage?.local?.set({ [CARD_PREFS_KEY]: prefs }).catch(() => undefined);
    },
  });
  void Promise.resolve(chrome.storage?.local?.get(CARD_PREFS_KEY))
    .then((r) => {
      const prefs = (r as Record<string, unknown> | undefined)?.[CARD_PREFS_KEY] as Partial<CardPrefs> | undefined;
      if (prefs && typeof prefs === "object") card.setPrefs({ expanded: prefs.expanded === true, side: prefs.side === "left" ? "left" : "right" });
    })
    .catch(() => undefined);
  let markers: DarkPatternMarkers | undefined;
  let gen = 0;
  /** Fetched policy pages, kept for the life of this page so SPA re-runs refetch nothing. */
  const policyCache = new Map<string, FetchedPage | undefined>();
  /** Page URL whose policies were analysed; a re-run on the same URL (form count changed) skips that work. */
  let analyzedFor = "";
  /** Page (origin + path) this script's card is showing checking or a verdict for; "" when none. */
  let activePage = "";
  let localChecksActive = false;
  /** Page whose full analysis (the ANALYZE round trip, AI included) is in flight; "" when none. */
  let analyzing = "";
  let localRefreshPending = false;

  let stopWatchers: (() => void) | undefined;
  const clearMarkers = () => {
    markers?.destroy();
    markers = undefined;
    stopWatchers?.();
    stopWatchers = undefined;
  };

  const runLocalChecks = () => {
    clearMarkers();
    const fees = detectFees(doc);
    const hits = findDarkPatterns(doc);
    let darkPatterns = hits.map((h) => h.finding);
    let thirdParty = thirdPartyAddresses(doc);
    let watchers: WatcherFinding[] = [];
    // Local findings go to the service worker only; they are never sent to the backend. The worker
    // matches the page's third-party addresses to known recorders and pixels and replies.
    const publish = () => {
      card.setLocal({ fees, darkPatterns, watchers });
      void send<LocalFindingsReply>({ type: MSG.LOCAL_FINDINGS, fees, darkPatterns, thirdParty }).then((r) => {
        const next = r?.watchers ?? [];
        if (next.map((w) => w.vendor).join() === watchers.map((w) => w.vendor).join()) return;
        watchers = next;
        card.setLocal({ fees, darkPatterns, watchers });
      });
    };
    if (hits.length) {
      markers = new DarkPatternMarkers(doc);
      // The shopper unticked a box: drop it from the card and popup too.
      markers.onUpdate = (next: DarkPatternFinding[]) => {
        darkPatterns = next;
        publish();
      };
      markers.mark(hits);
    }
    // Trackers often arrive after the page: keep the list current for a minute.
    stopWatchers = watchAddresses(doc, (next) => {
      thirdParty = next;
      publish();
    });
    publish();
  };

  const hideCard = () => {
    card.hide();
    activePage = "";
  };

  /**
   * Collects the policies. If that takes longer than EARLY_VERDICT_MS and some policy pages already
   * arrived, the worker's on-device rules give a first verdict from those (nothing is sent anywhere);
   * the full request still goes out when every fetch has finished or timed out.
   */
  const collect = async (my: number, url: string, pageKey: string, pageType: PageType) => {
    let done = false;
    const full = collectPolicies(doc, url, pageType, { settle: () => waitForDomQuiet(doc), cache: policyCache }).finally(() => {
      done = true;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const early = new Promise<"early">((r) => (timer = setTimeout(() => r("early"), EARLY_VERDICT_MS)));
    const first = await Promise.race([full.then(() => "done" as const, () => "done" as const), early]);
    clearTimeout(timer);
    if (first === "early" && my === gen && !dismissed && card.current === "checking") {
      // Same finder, but only pages already fetched (pending ones count as not read yet).
      const partial = await collectPolicies(doc, url, pageType, { fetchHtml: async (u) => policyCache.get(u) }).catch(() => undefined);
      const some = partial?.policies.some((p) => p.text) && partial.policies.some((p) => !p.text);
      if (partial && some && !done && my === gen) {
        const res = await send<AnalyzeReply>({ type: MSG.ANALYZE, request: partial, page: pageKey, preliminary: true });
        if (res?.ok && res.report && !done && my === gen && !dismissed && card.current === "checking") card.showReport(res.report, { provisional: true });
      }
    }
    return full;
  };

  /** Stops the late re-classify watcher (hydrated SPAs) of the previous "none" run. */
  let stopLateQualify: (() => void) | undefined;
  /** Page (without hash) that already had its one bounded late re-check, so re-runs can't chain watchers. */
  let lateWatchedFor = "";

  const run = async () => {
    const my = ++gen;
    stopLateQualify?.();
    stopLateQualify = undefined;
    const url = win.location.href;
    const pageKey = stripPageUrl(url);
    const cls = classify(doc, url);
    const reply = await send<PageReadyReply>({ type: MSG.PAGE_READY, pageType: cls.pageType, score: cls.score, url: pageKey });
    if (my !== gen) return;
    if (!reply || reply.paused || cls.pageType === "none") {
      localChecksActive = false;
      hideCard();
      clearMarkers();
      // A hydrated app may render its checkout or pricing table later: re-classify (bounded, read-only).
      if (reply && !reply.paused && cls.pageType === "none") {
        const base = url.split("#")[0];
        if (lateWatchedFor === base) return;
        lateWatchedFor = base;
        stopLateQualify = watchForLateQualify(win, () => {
          if (my === gen && win.location.href.split("#")[0] === base) safeRun();
        });
      }
      return;
    }
    dismissed = !!reply.dismissed;
    activePage = pageKey;
    if (!dismissed) {
      if (reply.report) card.showReport(reply.report);
      else card.showChecking(domainOf(url));
    }
    localChecksActive = true;
    runLocalChecks();
    if (analyzedFor === pageKey && reply.report) return; // same page, already analysed: local checks were enough

    try {
      const request = await collect(my, url, pageKey, cls.pageType);
      if (my !== gen) return;
      const msg = { type: MSG.ANALYZE, request, page: pageKey } as const;
      analyzing = pageKey;
      let res: AnalyzeReply | undefined;
      try {
        res = await send<AnalyzeReply>(msg);
        // No reply at all: Chrome stopped the worker mid-analysis. Ask the new worker once.
        if (res === undefined && my === gen) res = await send<AnalyzeReply>(msg);
      } finally {
        if (analyzing === pageKey) analyzing = "";
      }
      if (my !== gen) return;
      if (res?.ok && res.report) {
        analyzedFor = pageKey;
        if (!dismissed) card.showReport(res.report);
      } else {
        // Still no worker: let the next one close the tab's "checking" with what it has.
        if (res === undefined) void send({ type: MSG.STATUS, status: "error" });
        // Keep a verdict already on the card (on-device or cached); otherwise stay silent.
        if (card.current !== "report") hideCard();
      }
    } catch {
      // Anything unexpected after PAGE_READY: tell the service worker so the tab leaves "checking".
      if (my === gen && card.current !== "report") hideCard();
      void send({ type: MSG.STATUS, status: "error" });
    }
  };

  /** D-05: the user pressed "Scan this page" in the popup. Reads the live page as one policy. */
  const scan = async () => {
    const my = ++gen;
    const url = win.location.href;
    dismissed = false;
    void send({ type: MSG.SET_DISMISSED, dismissed: false });
    activePage = stripPageUrl(url);
    card.showChecking(domainOf(url));
    const ex = extractLiveDocument(doc, [CARD_HOST_ID, MARKS_HOST_ID]);
    const request = buildAnalyzeRequest({
      pageUrl: url,
      pageType: "none",
      linksFound: 1,
      policies: [{ url: stripPageUrl(url), kind: "other", text: ex.text }],
    });
    // A manual scan sends the scanned page's own (query-less) address: its text is the policy.
    const res = await send<AnalyzeReply>({ type: MSG.ANALYZE, request, page: stripPageUrl(url) });
    if (my !== gen) return;
    if (res?.ok && res.report) card.showReport(res.report);
    else hideCard();
  };

  chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
    switch (msg?.type) {
      case MSG.SCAN_CURRENT_PAGE: {
        // A checkout page holds the shopper's name, address and order: never send it as "policy text".
        if (classify(doc, win.location.href).pageType !== "none") {
          sendResponse({ ok: false, error: SCAN_REFUSED });
          return false;
        }
        void scan().catch(() => {
          hideCard();
          void send({ type: MSG.STATUS, status: "error" });
        });
        sendResponse({ ok: true });
        return false;
      }
      case MSG.SHOW_CARD: {
        // The shopper asked for the card again from the popup: undo the dismissal and re-run (the
        // worker answers from its stored report, so nothing new is fetched or sent).
        dismissed = false;
        void send({ type: MSG.SET_DISMISSED, dismissed: false });
        safeRun();
        sendResponse({ ok: true });
        return false;
      }
      case MSG.REPORT: {
        // Only for the page on screen, and only while this run is still checking or showing a verdict
        // for it: a late reply after the shopper moved on (or closed the card) is dropped.
        const here = stripPageUrl(win.location.href);
        const live = card.current === "checking" || card.current === "report";
        // An on-device result while the AI review is still running is labelled as a quick check, so
        // the later AI verdict reads as an upgrade rather than a glitch.
        if (!dismissed && live && msg.page === here && msg.page === activePage)
          card.showReport(msg.report, { provisional: analyzing === msg.page && !msg.report.stats.usedLlm });
        return false;
      }
      case MSG.STATUS:
        if (msg.status === "error" && card.current === "checking") hideCard();
        return false;
      case MSG.PING:
        sendResponse({ ok: true });
        return false;
    }
    return false;
  });

  // Re-read visible summary text after the shop has handled the shopper's choice.
  // No policy scan or backend request is needed when a checkbox or radio changes.
  doc.addEventListener("change", (event) => {
    const target = event.target as Element | null;
    if (!localChecksActive || localRefreshPending || !target?.matches?.('input[type="checkbox"], input[type="radio"]')) return;
    localRefreshPending = true;
    const generation = gen;
    void waitForDomQuiet(doc, 150, 800).then(() => {
      localRefreshPending = false;
      if (localChecksActive && generation === gen) runLocalChecks();
    });
  });

  const safeRun = () =>
    void run().catch(() => {
      hideCard();
      void send({ type: MSG.STATUS, status: "error" });
    });
  /**
   * Same address, different number of forms (a chat widget, newsletter pop-up or search box came or
   * went). This is not a navigation: a card already on screen keeps its verdict and only the local
   * fee and add-on checks re-run; a page without a card is re-classified in place, and a running
   * late re-check (hydrated pricing tables) is left alone instead of being cancelled.
   */
  const onFormsChanged = () => {
    const pageKey = stripPageUrl(win.location.href);
    if (activePage === pageKey && card.current !== "hidden") {
      if (localChecksActive) runLocalChecks();
      return;
    }
    if (activePage === pageKey) return; // shopper closed the card on this page: stay closed
    if (classify(doc, win.location.href).pageType !== "none") safeRun();
  };
  watchNavigation(win, (urlChanged) => (urlChanged ? safeRun() : onFormsChanged()));
  safeRun();
}

if (typeof chrome !== "undefined" && chrome.runtime?.id && typeof window !== "undefined") {
  startContent(window);
}
