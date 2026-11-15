import {
  MSG,
  domainOf,
  stripPageUrl,
  type AnalyzeReply,
  type Message,
  type PageReadyReply,
} from "@xcavate/shared";
import { send } from "../lib/messaging";
import { buildAnalyzeRequest } from "../lib/request";
import { CARD_HOST_ID, Card } from "./card";
import { classify } from "./classifier";
import { collectPolicies, waitForDomQuiet } from "./collect";
import { DarkPatternMarkers, MARKS_HOST_ID, findDarkPatterns } from "./darkPatterns";
import { extractLiveDocument } from "./extractor";
import { detectFees } from "./fees";
import { watchNavigation } from "./spa";

/**
 * D-06 content orchestrator: classify → PAGE_READY → find → fetch → ANALYZE → card.
 * Nothing here clicks, fills, submits or blocks anything, and nothing reads form values.
 */

const DISMISS_KEY = "xcavate:dismissed";

declare global {
  interface Window {
    __xcavateLoaded?: boolean;
  }
}

function isDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function setDismissed(v: boolean): void {
  try {
    if (v) sessionStorage.setItem(DISMISS_KEY, "1");
    else sessionStorage.removeItem(DISMISS_KEY);
  } catch {
    /* storage blocked: dismissal lasts until reload */
  }
}

export function startContent(win: Window = window): void {
  if (win.__xcavateLoaded) return;
  win.__xcavateLoaded = true;
  const doc = win.document;
  const card = new Card(doc, { onDismiss: () => setDismissed(true) });
  let markers: DarkPatternMarkers | undefined;
  let gen = 0;

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
    if (!isDismissed()) {
      if (reply.report) card.showReport(reply.report);
      else card.showChecking(domainOf(url));
    }
    runLocalChecks();

    const request = await collectPolicies(doc, url, cls.pageType, { settle: () => waitForDomQuiet(doc) });
    if (my !== gen) return;
    const res = await send<AnalyzeReply>({ type: MSG.ANALYZE, request });
    if (my !== gen) return;
    if (res?.ok && res.report) {
      if (!isDismissed()) card.showReport(res.report);
    } else if (!reply.report) {
      card.hide(); // backend down or failed: silent, the page is unaffected
    }
  };

  /** D-05: the user pressed "Scan this page" in the popup. Reads the live page as one policy. */
  const scan = async () => {
    const my = ++gen;
    const url = win.location.href;
    setDismissed(false);
    card.showChecking(domainOf(url));
    const ex = extractLiveDocument(doc, [CARD_HOST_ID, MARKS_HOST_ID]);
    const request = buildAnalyzeRequest({
      pageUrl: url,
      pageType: "none",
      linksFound: 1,
      policies: [{ url: stripPageUrl(url), kind: "other", text: ex.text }],
    });
    const res = await send<AnalyzeReply>({ type: MSG.ANALYZE, request });
    if (my !== gen) return;
    if (res?.ok && res.report) card.showReport(res.report);
    else card.hide();
  };

  chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
    switch (msg?.type) {
      case MSG.SCAN_CURRENT_PAGE:
        void scan();
        sendResponse({ ok: true });
        return false;
      case MSG.REPORT:
        if (!isDismissed()) card.showReport(msg.report);
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

  watchNavigation(win, () => {
    void run().catch(() => card.hide());
  });
  void run().catch(() => card.hide());
}

if (typeof chrome !== "undefined" && chrome.runtime?.id && typeof window !== "undefined") {
  startContent(window);
}
