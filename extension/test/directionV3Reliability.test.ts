import { DEFAULT_SETTINGS, SAMPLE_REPORT_GREEN, SAMPLE_REPORT_RED, type AnalyzeRequest, type Message, type Report, type TabState } from "@xcavate/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../../fixtures/load";
import { createHandlers, STALE_CHECKING_MS } from "../src/background/handlers";
import { updateTab } from "../src/background/state";
import { CARD_HOST_ID, Card } from "../src/content/card";
import { EARLY_VERDICT_MS, startContent } from "../src/content/index";
import { FETCH_TIMEOUT_MS } from "../src/lib/fetchCapped";
import { LOCAL_CHECK_NOTE } from "../src/popup/render";
import { installChromeMock } from "./chromeMock";
import { setLiveDocument } from "./helpers";

/** Reliability review (direction v3): every finding has a regression test here. */

const TAB = 7;
const DOMAIN = "streamnest.localhost:4000";
const PAGE = "http://streamnest.localhost:4000/checkout";
const API = "http://localhost:8787";
const FILLER =
  "Our team works hard to bring you a great selection and friendly service. We were founded by people who love good design and fair dealing. ".repeat(4);
const RED_TEXT = [
  "About us. " + FILLER,
  "Your membership renews automatically every month until you cancel.",
  "Cancellation requests must be made by telephone with at least 30 days' notice.",
].join("\n\n");

function req(text = RED_TEXT): AnalyzeRequest {
  return { pageUrl: "http://streamnest.localhost:4000/", pageType: "signup", linksFound: 1, policies: [{ url: "http://streamnest.localhost:4000/terms", kind: "terms", text }] };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const withStats = (r: Report, usedLlm: boolean): Report => ({
  ...r,
  domain: DOMAIN,
  policies: [{ url: "http://streamnest.localhost:4000/terms", kind: "terms", textHash: "a".repeat(64), status: "analyzed" }],
  stats: { ...r.stats, usedLlm },
});

/** A backend: POST /v1/analyze answers `report()`, /healthz says which model it runs, /v1/report 404s. */
function backend(report: () => Report, llm: "anthropic" | "mock" = "anthropic") {
  const fn = vi.fn(async (u: string, _init?: RequestInit) => {
    if (u.endsWith("/healthz")) return json({ ok: true, llm });
    if (u.includes("/v1/report")) return new Response("", { status: 404 });
    return json(report());
  });
  const analyzeCalls = () => fn.mock.calls.filter(([u]) => String(u).endsWith("/v1/analyze")).length;
  return { fetchImpl: fn as unknown as typeof fetch, fn, analyzeCalls };
}

let mock: ReturnType<typeof installChromeMock>;
beforeEach(() => {
  mock = installChromeMock();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tab = () => mock.session.data()["tab:" + TAB] as Record<string, unknown> | undefined;
const sentToTab = (type: string) => mock.chrome.tabs.sendMessage.mock.calls.filter(([, m]) => (m as { type: string }).type === type).map(([, m]) => m as Record<string, unknown>);
const setTabUrl = (url: string | undefined) => {
  (mock.chrome.tabs as unknown as { get: unknown }).get = vi.fn(async () => ({ id: TAB, url }));
};

describe("item 1: a rules-only answer from a model-backed service is not cached", () => {
  it("is shown with the 'AI check unavailable' note and the next visit asks the AI again", async () => {
    const b = backend(() => withStats(SAMPLE_REPORT_RED, false));
    const h = createHandlers({ fetchImpl: b.fetchImpl });
    const r = await h.analyze(req(), TAB, PAGE);
    expect(r).toMatchObject({ ok: true, report: { stats: { usedLlm: false } } });
    expect(mock.local.data()["report:" + DOMAIN]).toBeUndefined();
    expect(tab()).toMatchObject({ status: "ready", localCheck: "unavailable" });
    const state = (await h.getState(TAB)) as TabState;
    expect(state).toMatchObject({ status: "ready", localCheck: "unavailable", report: { verdict: "red" } });
    expect(LOCAL_CHECK_NOTE.unavailable).toBe("AI check unavailable, showing the on-device result.");

    await h.analyze(req(), TAB, PAGE);
    expect(b.analyzeCalls()).toBe(2);
  });

  it("a report with the AI pass is cached as before (no /healthz needed)", async () => {
    const b = backend(() => withStats(SAMPLE_REPORT_RED, true));
    const h = createHandlers({ fetchImpl: b.fetchImpl });
    await h.analyze(req(), TAB, PAGE);
    expect(mock.local.data()["report:" + DOMAIN]).toBeDefined();
    expect(tab()?.localCheck).toBeUndefined();
    expect(b.fn.mock.calls.some(([u]) => String(u).endsWith("/healthz"))).toBe(false);
  });

  it("mock mode (the service is the rules engine on purpose) caches rules-only reports", async () => {
    const b = backend(() => withStats(SAMPLE_REPORT_RED, false), "mock");
    const h = createHandlers({ fetchImpl: b.fetchImpl });
    await h.analyze(req(), TAB, PAGE);
    expect(mock.local.data()["report:" + DOMAIN]).toBeDefined();
    expect(tab()?.localCheck).toBeUndefined();
  });

  it("an old cached rules-only report is not reused when the service runs a model", async () => {
    const b = backend(() => withStats(SAMPLE_REPORT_GREEN, true));
    const h = createHandlers({ fetchImpl: b.fetchImpl });
    const { normalizeForHash, sha256Hex } = await import("@xcavate/shared");
    const hash = await sha256Hex(normalizeForHash(RED_TEXT));
    const stale = { ...withStats(SAMPLE_REPORT_RED, false), policies: [{ url: "http://streamnest.localhost:4000/terms", kind: "terms" as const, textHash: hash, status: "analyzed" as const }] };
    await mock.local.set({ ["report:" + DOMAIN]: { report: stale, savedAt: Date.now() } });
    const r = await h.analyze(req(), TAB, PAGE);
    expect(b.analyzeCalls()).toBe(1);
    expect(r.report?.verdict).toBe("green");
  });
});

describe("item 3: REPORT carries its page; the content script drops other pages' reports", () => {
  it("the worker's REPORT names the page", async () => {
    const b = backend(() => withStats(SAMPLE_REPORT_RED, true));
    await createHandlers({ fetchImpl: b.fetchImpl }).analyze(req(), TAB, PAGE);
    const [rep] = sentToTab("REPORT");
    expect(rep.page).toBe(PAGE);
  });

  it("content: a REPORT for another page, or after the card closed, is ignored", async () => {
    const show = vi.spyOn(Card.prototype, "showReport");
    mock.chrome.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const m = msg as Message;
      if (m.type === "PAGE_READY") return {};
      if (m.type === "ANALYZE") return new Promise(() => undefined); // still checking
      if (m.type === "FETCH_HTML") return { ok: false, status: 404 };
      return { ok: true };
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    history.replaceState({}, "", "/checkout");
    setLiveDocument(loadFixture("streamnest", "checkout"));
    window.__xcavateLoaded = false;
    startContent(window);
    await vi.waitFor(() => expect(document.getElementById(CARD_HOST_ID)).not.toBeNull());
    const listener = mock.listeners[0];
    listener({ type: "REPORT", report: SAMPLE_REPORT_RED, page: "http://localhost:3000/other" }, {}, () => undefined);
    expect(show).not.toHaveBeenCalled();
    listener({ type: "REPORT", report: SAMPLE_REPORT_RED, page: "http://localhost:3000/checkout" }, {}, () => undefined);
    expect(show).toHaveBeenCalledTimes(1);
    document.getElementById(CARD_HOST_ID)?.remove();
  });
});

describe("item 4: navigation ends the old page's state", () => {
  it("tabs.onUpdated to another page resets state and badge; same page is a no-op", async () => {
    const h = createHandlers({ fetchImpl: backend(() => withStats(SAMPLE_REPORT_RED, true)).fetchImpl });
    await h.pageReady({ type: "PAGE_READY", pageType: "checkout", score: 9, url: PAGE }, TAB);
    await h.analyze(req(), TAB, PAGE);
    expect(tab()?.status).toBe("ready");
    await h.tabUpdated(TAB, { url: PAGE + "?step=2#x" });
    expect(tab()?.status).toBe("ready");
    await h.tabUpdated(TAB, { status: "loading" }, undefined); // chrome:// or a PDF: no URL for us
    expect(tab()).toEqual({ status: "idle", pageUrl: "elsewhere:" });
    expect(mock.badges.get(TAB)?.text).toBe("");
  });

  it("a late backend reply after the tab moved to a page without a content script writes nothing", async () => {
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn((u: string) => (u.endsWith("/v1/analyze") ? new Promise<Response>((r) => (resolve = r)) : Promise.resolve(json({}, 404))));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = h.analyze(req(), TAB, PAGE);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    setTabUrl("chrome://newtab/");
    mock.chrome.tabs.sendMessage.mockClear();
    resolve(json(withStats(SAMPLE_REPORT_GREEN, true)));
    await p;
    expect(tab()?.status).toBe("checking"); // untouched by the late reply
    expect(sentToTab("REPORT")).toHaveLength(0);
  });
});

describe("item 5: scanTab sets 'checking' before the content script starts", () => {
  it("an AI-off scan result that lands during sendMessage stays 'ready'", async () => {
    await mock.local.set({ settings: { ...DEFAULT_SETTINGS, aiCheck: false } });
    const h = createHandlers({ fetchImpl: vi.fn() as unknown as typeof fetch });
    mock.chrome.tabs.sendMessage.mockImplementation(async (_t: number, m: unknown) => {
      if ((m as Message).type !== "SCAN_CURRENT_PAGE") return undefined;
      expect(tab()?.status).toBe("checking");
      await h.analyze({ ...req(), pageType: "none" }, TAB, "http://streamnest.localhost:4000/terms");
      return { ok: true };
    });
    expect(await h.scanTab(TAB)).toEqual({ ok: true });
    expect(tab()).toMatchObject({ status: "ready", localCheck: "off" });
    expect(mock.badges.get(TAB)?.text).toMatch(/^!/);
  });

  it("a refused scan puts the previous state back", async () => {
    await updateTab(TAB, () => ({ status: "idle", pageUrl: PAGE }));
    mock.chrome.tabs.sendMessage.mockResolvedValue({ ok: false, error: "checkout" });
    const r = await createHandlers().scanTab(TAB);
    expect(r.ok).toBe(false);
    expect(tab()?.status).toBe("idle");
  });
});

describe("item 6: worker stopped mid-analysis", () => {
  it("a pending on-device report left by a stopped worker reads as 'unavailable'", async () => {
    let hang = true;
    const fetchImpl = vi.fn(async (u: string) => (u.endsWith("/v1/analyze") && hang ? new Promise<Response>(() => undefined) : json({}, 404)));
    const dead = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    void dead.analyze(req(), TAB, PAGE);
    await vi.waitFor(() => expect(tab()).toMatchObject({ status: "checking", localCheck: "pending" }));
    hang = false;
    const fresh = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch }); // the restarted worker
    const state = (await fresh.getState(TAB)) as TabState;
    expect(state).toMatchObject({ status: "ready", localCheck: "unavailable", report: { verdict: "red" } });
    expect(tab()?.status).toBe("ready");
  });

  it("a 'checking' state without a report is closed only once it is old", async () => {
    let t = 1_000_000;
    await updateTab(TAB, () => ({ status: "checking", pageUrl: PAGE, domain: DOMAIN, owner: "gone", checkingSince: t }));
    const h = createHandlers({ now: () => t });
    expect(((await h.getState(TAB)) as TabState).status).toBe("checking");
    t += STALE_CHECKING_MS + 1;
    expect(((await h.getState(TAB)) as TabState).status).toBe("error");
  });

  it("STATUS error from the content script finalises a pending local report as the result", async () => {
    await updateTab(TAB, () => ({ status: "checking", pageUrl: PAGE, localReport: SAMPLE_REPORT_RED, localCheck: "pending" }));
    const h = createHandlers();
    await h.handle({ type: "STATUS", status: "error" }, { tab: { id: TAB } } as chrome.runtime.MessageSender);
    expect(tab()).toMatchObject({ status: "ready", localCheck: "unavailable" });
    expect(mock.badges.get(TAB)?.text).toBe("!4");
  });

  it("content: no reply to ANALYZE keeps the on-device card, retries once, then tells the worker", async () => {
    const hide = vi.spyOn(Card.prototype, "hide");
    let analyzeCount = 0;
    const sent: Message[] = [];
    mock.chrome.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const m = msg as Message;
      sent.push(m);
      if (m.type === "PAGE_READY") return {};
      if (m.type === "FETCH_HTML") return { ok: false, status: 404 };
      if (m.type === "ANALYZE") {
        analyzeCount++;
        // The worker pushed its on-device verdict, then Chrome stopped it: no reply.
        mock.listeners[0]({ type: "REPORT", report: SAMPLE_REPORT_RED, page: "http://localhost:3000/checkout" }, {}, () => undefined);
        return undefined;
      }
      return { ok: true };
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    history.replaceState({}, "", "/checkout");
    setLiveDocument(loadFixture("streamnest", "checkout"));
    window.__xcavateLoaded = false;
    startContent(window);
    await vi.waitFor(() => expect(sent.some((m) => m.type === "STATUS")).toBe(true));
    expect(analyzeCount).toBe(2);
    expect(hide).not.toHaveBeenCalled();
    expect(document.getElementById(CARD_HOST_ID)).not.toBeNull();
    document.getElementById(CARD_HOST_ID)?.remove();
  });
});

describe("item 7: tab writes are serialised", () => {
  it("LOCAL_FINDINGS racing the final write loses nothing", async () => {
    const h = createHandlers({ fetchImpl: backend(() => withStats(SAMPLE_REPORT_RED, true)).fetchImpl });
    const sender = { tab: { id: TAB, url: PAGE } } as chrome.runtime.MessageSender;
    const fees = { currency: "USD", lines: [{ label: "Service fee", amount: 4.95, kind: "extra_fee" as const }], extrasTotal: 4.95 };
    await Promise.all([
      h.analyze(req(), TAB, PAGE),
      ...Array.from({ length: 5 }, () => h.handle({ type: "LOCAL_FINDINGS", fees, darkPatterns: [] }, sender)),
    ]);
    expect(tab()).toMatchObject({ status: "ready", fees });
  });
});

describe("item 8: turning the AI check off mid-flight", () => {
  it("aborts the backend call and keeps the on-device result", async () => {
    let aborted = false;
    const fetchImpl = vi.fn((u: string, init?: RequestInit) => {
      if (!u.endsWith("/v1/analyze")) return Promise.resolve(json({}, 404));
      return new Promise<Response>((_r, rej) =>
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }),
      );
    });
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = h.analyze(req(), TAB, PAGE);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await mock.local.set({ settings: { ...DEFAULT_SETTINGS, aiCheck: false } });
    h.settingsChanged({ ...DEFAULT_SETTINGS, aiCheck: false }, DEFAULT_SETTINGS);
    const r = await p;
    expect(aborted).toBe(true);
    expect(r).toMatchObject({ ok: true, report: { verdict: "red", stats: { usedLlm: false } } });
    expect(tab()).toMatchObject({ status: "ready", localCheck: "off" });
  });

  it("nothing is sent once the setting is off, even if the call was about to start", async () => {
    const fetchImpl = vi.fn(async () => json(withStats(SAMPLE_REPORT_GREEN, true)));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    // Settings flip between the first read and the backend call (simulated via the policy-hash read).
    const realGet = mock.local.get.getMockImplementation()!;
    mock.local.get.mockImplementation(async (keys) => {
      if (typeof keys === "string" && keys.startsWith("hash:")) await mock.local.set({ settings: { ...DEFAULT_SETTINGS, aiCheck: false } });
      return realGet(keys);
    });
    const r = await h.analyze(req(), TAB, PAGE);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.report?.stats.usedLlm).toBe(false);
    expect(tab()).toMatchObject({ status: "ready", localCheck: "off" });
  });
});

describe("item 10: slow policy pages", () => {
  it("each fetch attempt gets about 4 s", () => {
    expect(FETCH_TIMEOUT_MS).toBe(4_000);
  });

  it("the worker's preliminary pass is on-device only and never overwrites a result", async () => {
    const fetchImpl = vi.fn();
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await updateTab(TAB, () => ({ status: "checking", pageUrl: PAGE }));
    const r = await h.analyze(req(), TAB, PAGE, true);
    expect(r).toMatchObject({ ok: true, report: { verdict: "red" } });
    expect(tab()).toMatchObject({ status: "checking", localCheck: "pending" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await updateTab(TAB, (c) => ({ ...c, status: "ready", localReport: undefined, localCheck: undefined }));
    await h.analyze(req(), TAB, PAGE, true);
    expect(tab()?.status).toBe("ready");
  });

  it("content: a policy page still loading after EARLY_VERDICT_MS → preliminary on-device verdict from what arrived", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const show = vi.spyOn(Card.prototype, "showReport");
    const sent: Message[] = [];
    let releaseTerms!: () => void;
    mock.chrome.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const m = msg as Message;
      sent.push(m);
      if (m.type === "PAGE_READY") return {};
      if (m.type === "FETCH_HTML") {
        // The cross-origin terms page is slow.
        await new Promise<void>((r) => (releaseTerms = r));
        return { ok: true, html: loadFixture("streamnest", "terms"), status: 200 };
      }
      if (m.type === "ANALYZE") return m.preliminary ? { ok: true, report: SAMPLE_REPORT_GREEN } : { ok: true, report: SAMPLE_REPORT_RED };
      return { ok: true };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        const page = new URL(u).pathname.split("/").pop()!;
        try {
          return new Response(loadFixture("streamnest", page), { status: 200, headers: { "content-type": "text/html" } });
        } catch {
          return new Response("", { status: 404 });
        }
      }),
    );
    history.replaceState({}, "", "/checkout");
    setLiveDocument(loadFixture("streamnest", "checkout"));
    window.__xcavateLoaded = false;
    startContent(window);
    await vi.advanceTimersByTimeAsync(EARLY_VERDICT_MS + 100);
    await vi.waitFor(() => expect(show).toHaveBeenCalledWith(expect.objectContaining({ verdict: "green" })));
    const pre = sent.find((m) => m.type === "ANALYZE" && m.preliminary) as Extract<Message, { type: "ANALYZE" }>;
    expect(pre.request.policies.some((p) => p.text)).toBe(true);
    expect(pre.request.policies.some((p) => !p.text)).toBe(true);
    releaseTerms();
    await vi.waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ verdict: "red" })));
    const full = sent.filter((m) => m.type === "ANALYZE" && !m.preliminary) as Extract<Message, { type: "ANALYZE" }>[];
    expect(full).toHaveLength(1);
    expect(full[0].request.policies.every((p) => p.text)).toBe(true);
    document.getElementById(CARD_HOST_ID)?.remove();
  });
});

describe("item 9: hydrated pages are re-classified", () => {
  it("a page that renders its checkout after load gets a card without a reload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sent: Message[] = [];
    mock.chrome.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const m = msg as Message;
      sent.push(m);
      if (m.type === "PAGE_READY") return {};
      if (m.type === "ANALYZE") return new Promise(() => undefined);
      if (m.type === "FETCH_HTML") return { ok: false, status: 404 };
      return { ok: true };
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    history.replaceState({}, "", "/app");
    setLiveDocument("<body><div id=root>Loading…</div></body>");
    window.__xcavateLoaded = false;
    startContent(window);
    await vi.advanceTimersByTimeAsync(10);
    const ready = () => sent.filter((m) => m.type === "PAGE_READY") as Extract<Message, { type: "PAGE_READY" }>[];
    expect(ready()).toHaveLength(1);
    expect(ready()[0].pageType).toBe("none");
    // The app hydrates: the checkout appears (no URL change, no new form count signature needed).
    const checkout = loadFixture("streamnest", "checkout");
    document.getElementById("root")!.innerHTML = checkout.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(ready().some((m) => m.pageType !== "none")).toBe(true));
    document.getElementById(CARD_HOST_ID)?.remove();
  });
});
