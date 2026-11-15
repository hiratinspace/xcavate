import {
  MSG,
  domainOf,
  stripPageUrl,
  type AnalyzeReply,
  type Message,
  type PageReadyReply,
} from "@xcavate/shared/core";
import { send } from "../lib/messaging";
import { buildAnalyzeRequest } from "../lib/request";
import { CARD_HOST_ID, Card } from "./card";
import { classify } from "./classifier";
import { collectPolicies, waitForDomQuiet, type FetchedPage } from "./collect";
import { DarkPatternMarkers, MARKS_HOST_ID, findDarkPatterns } from "./darkPatterns";
import { extractLiveDocument } from "./extractor";
import { detectFees } from "./fees";
import { watchNavigation } from "./spa";

/**
 * D-06 content orchestrator: classify → PAGE_READY → find → fetch → ANALYZE → card.
 * Nothing here clicks, fills, submits or blocks anything, and nothing reads form values.
 */

declare global {
  interface Window {
    __xcavateLoaded?: boolean;
  }
}

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
  });
  let markers: DarkPatternMarkers | undefined;
  let gen = 0;
  /** Fetched policy pages, kept for the life of this page so SPA re-runs refetch nothing. */
  const policyCache = new Map<string, FetchedPage | undefined>();
  /** Page URL whose policies were analysed; a re-run on the same URL (form count changed) skips that work. */
  let analyzedFor = "";

  const clearMarkers = () => {
    markers?.destroy();
    markers = undefined;
  };

  const runLocalChecks = () => {
    clearMarkers();
    const fees = detectFees(doc);
    const hits = findDarkPatterns(doc);
    if (hits.length) {
      markers = new DarkPatternMarkers(doc);
      markers.mark(hits);
    }
    const darkPatterns = hits.map((h) => h.finding);
    card.setLocal({ fees, darkPatterns });
    // Local findings go to the service worker only; they are never sent to the backend.
    void send({ type: MSG.LOCAL_FINDINGS, fees, darkPatterns });
  };

  const run = async () => {
    const my = ++gen;
    const url = win.location.href;
    const cls = classify(doc, url);
    const reply = await send<PageReadyReply>({ type: MSG.PAGE_READY, pageType: cls.pageType, score: cls.score, url: stripPageUrl(url) });
    if (my !== gen) return;
    if (!reply || reply.paused || cls.pageType === "none") {
      card.hide();
      clearMarkers();
      return;
    }
    dismissed = !!reply.dismissed;
    if (!dismissed) {
      if (reply.report) card.showReport(reply.report);
      else card.showChecking(domainOf(url));
    }
    runLocalChecks();
    const pageKey = stripPageUrl(url);
    if (analyzedFor === pageKey && reply.report) return; // same page, already analysed: local checks were enough

    try {
      const request = await collectPolicies(doc, url, cls.pageType, { settle: () => waitForDomQuiet(doc), cache: policyCache });
      if (my !== gen) return;
      const res = await send<AnalyzeReply>({ type: MSG.ANALYZE, request, page: pageKey });
      if (my !== gen) return;
      if (res?.ok && res.report) {
        analyzedFor = pageKey;
        if (!dismissed) card.showReport(res.report);
      } else if (!reply.report) {
        card.hide(); // backend down or failed: silent, the page is unaffected
      }
    } catch {
      // Anything unexpected after PAGE_READY: tell the service worker so the tab leaves "checking".
      if (my === gen && !reply.report) card.hide();
      void send({ type: MSG.STATUS, status: "error" });
    }
  };

  /** D-05: the user pressed "Scan this page" in the popup. Reads the live page as one policy. */
  const scan = async () => {
    const my = ++gen;
    const url = win.location.href;
    dismissed = false;
    void send({ type: MSG.SET_DISMISSED, dismissed: false });
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
    else card.hide();
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
          card.hide();
          void send({ type: MSG.STATUS, status: "error" });
        });
        sendResponse({ ok: true });
        return false;
      }
      case MSG.REPORT:
        if (!dismissed) card.showReport(msg.report);
        return false;
      case MSG.STATUS:
        if (msg.status === "error" && card.current === "checking") card.hide();
        return false;
      case MSG.PING:
        sendResponse({ ok: true });
        return false;
    }
    return false;
  });

  const safeRun = () =>
    void run().catch(() => {
      card.hide();
      void send({ type: MSG.STATUS, status: "error" });
    });
  watchNavigation(win, safeRun);
  safeRun();
}

if (typeof chrome !== "undefined" && chrome.runtime?.id && typeof window !== "undefined") {
  startContent(window);
}
