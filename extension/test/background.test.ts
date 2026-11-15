import { MSG, REPORT_TTL_MS, SAMPLE_REPORT_GREEN, SAMPLE_REPORT_RED, normalizeForHash, sha256Hex, type AnalyzeRequest, type Report } from "@xcavate/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { badgeFor } from "../src/background/badge";
import { createHandlers } from "../src/background/handlers";
import { installChromeMock } from "./chromeMock";

const TAB = 7;
const sender = { tab: { id: TAB, url: "https://shop.example/checkout" } } as chrome.runtime.MessageSender;
const DOMAIN = "streamnest.localhost:4000";
const TEXT = "Your subscription renews automatically each month until you cancel. ".repeat(10);

function req(text = TEXT): AnalyzeRequest {
  return {
    pageUrl: "http://streamnest.localhost:4000/checkout",
    pageType: "signup",
    linksFound: 1,
    policies: [{ url: "http://streamnest.localhost:4000/subscription", kind: "subscription", text }],
  };
}

async function reportFor(text = TEXT): Promise<Report> {
  return {
    ...SAMPLE_REPORT_RED,
    policies: [{ url: "http://streamnest.localhost:4000/subscription", kind: "subscription", textHash: await sha256Hex(normalizeForHash(text)), status: "analyzed" }],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let mock: ReturnType<typeof installChromeMock>;
beforeEach(() => {
  mock = installChromeMock();
});

describe("PAGE_READY", () => {
  it("non-qualifying page: idle, badge cleared, no network", async () => {
    const fetchImpl = vi.fn();
    const h = createHandlers({ fetchImpl });
    const r = await h.handle({ type: MSG.PAGE_READY, pageType: "none", score: 0, url: "http://streamnest.localhost:4000/" }, sender);
    expect(r).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mock.badges.get(TAB)?.text).toBe("");
    expect(mock.session.data()["tab:7"]).toMatchObject({ status: "idle" });
  });

  it("paused domain: replies paused and makes no network calls", async () => {
    await mock.local.set({ settings: { enabled: true, apiBase: "http://localhost:8787", pausedDomains: [DOMAIN] } });
    const fetchImpl = vi.fn();
    const h = createHandlers({ fetchImpl });
    const r = await h.handle({ type: MSG.PAGE_READY, pageType: "signup", score: 9, url: "http://streamnest.localhost:4000/checkout" }, sender);
    expect(r).toEqual({ paused: true });
    const a = await h.analyze(req(), TAB);
    expect(a.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a cached report within 24 h and sets the badge", async () => {
    await mock.local.set({ ["report:" + DOMAIN]: { report: SAMPLE_REPORT_RED, savedAt: 1000 } });
    const fetchImpl = vi.fn();
    const h = createHandlers({ fetchImpl, now: () => 1000 + REPORT_TTL_MS - 1 });
    const r = await h.pageReady({ type: "PAGE_READY", pageType: "signup", score: 9, url: "http://streamnest.localhost:4000/checkout" }, TAB);
    expect(r.report?.verdict).toBe("red");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mock.badges.get(TAB)?.text).toBe("!4");
  });

  it("expired cache → tries GET /v1/report (F-06) without holding up the card, then pushes it", async () => {
    await mock.local.set({ ["report:" + DOMAIN]: { report: SAMPLE_REPORT_RED, savedAt: 0 } });
    const fetchImpl = vi.fn(async () => jsonResponse({ ...SAMPLE_REPORT_GREEN, domain: DOMAIN, cached: true }));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => REPORT_TTL_MS + 10 });
    const r = await h.pageReady({ type: "PAGE_READY", pageType: "signup", score: 9, url: "http://streamnest.localhost:4000/checkout" }, TAB);
    // The reply comes at once (the card shows "checking"); the shared report follows as REPORT.
    expect(r.report).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:8787/v1/report?domain=streamnest.localhost%3A4000", expect.anything());
    await vi.waitFor(() => expect(mock.badges.get(TAB)?.text).toBe("✓"));
    expect(mock.chrome.tabs.sendMessage).toHaveBeenCalledWith(
      TAB,
      expect.objectContaining({ type: "REPORT", page: "http://streamnest.localhost:4000/checkout", report: expect.objectContaining({ verdict: "green" }) }),
    );
    expect(mock.session.data()["tab:" + TAB]).toMatchObject({ status: "ready" });
  });

  it("backend lookup 404 → no report, checking badge", async () => {
    const h = createHandlers({ fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch });
    const r = await h.pageReady({ type: "PAGE_READY", pageType: "checkout", score: 9, url: "http://streamnest.localhost:4000/checkout" }, TAB);
    expect(r).toEqual({});
    expect(mock.badges.get(TAB)?.text).toBe("…");
  });
});

describe("ANALYZE", () => {
  it("posts only AnalyzeRequest fields, stores report + hashes, sets badge", async () => {
    const report = await reportFor();
    const fetchImpl = vi.fn(async (_u: string, _init?: RequestInit) => jsonResponse(report));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const dirty = { ...req(), cart: ["secret"], fees: { total: 1 }, pageUrl: "http://streamnest.localhost:4000/checkout?coupon=ME#x" } as unknown as AnalyzeRequest;
    const r = await h.analyze(dirty, TAB);
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:8787/v1/analyze");
    expect(init?.credentials).toBe("omit");
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body).sort()).toEqual(["linksFound", "pageType", "pageUrl", "policies"]);
    expect(body.pageUrl).toBe("http://streamnest.localhost:4000/checkout");
    expect(Object.keys(body.policies[0]).sort()).toEqual(["kind", "text", "url"]);
    expect(mock.local.data()["report:" + DOMAIN]).toBeDefined();
    expect(mock.local.data()["hash:http://streamnest.localhost:4000/subscription"]).toBe(report.policies[0].textHash);
    expect(mock.badges.get(TAB)?.text).toBe("!4");
    expect(mock.session.data()["tab:7"]).toMatchObject({ status: "ready" });
  });

  it("same policy text within 24 h → cached report, no backend call", async () => {
    const report = await reportFor();
    const fetchImpl = vi.fn(async () => jsonResponse(report));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await h.analyze(req(), TAB);
    await h.analyze(req(), TAB);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("changed policy text → calls backend with previousHash (F-05)", async () => {
    const report = await reportFor();
    const fetchImpl = vi.fn(async (_u: string, _i?: RequestInit) => jsonResponse(report));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await h.analyze(req(), TAB);
    await h.analyze(req(TEXT + " Prices rise to $19.99."), TAB);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(body.policies[0].previousHash).toBe(report.policies[0].textHash);
  });

  it("de-dupes concurrent calls for the same domain", async () => {
    const report = await reportFor();
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const a = h.analyze(req(), 1);
    const b = h.analyze(req(), 2);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolve(jsonResponse(report));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.report?.verdict).toBe("red");
    expect(rb.report?.verdict).toBe("red");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("backend down → the on-device verdict stands: status ready, no STATUS error, no throw (V-06)", async () => {
    const h = createHandlers({ fetchImpl: (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch });
    const r = await h.analyze(req(), TAB);
    expect(r.ok).toBe(true);
    expect(r.report?.stats.usedLlm).toBe(false);
    expect(mock.session.data()["tab:7"]).toMatchObject({ status: "ready", localCheck: "unavailable" });
    expect(mock.chrome.tabs.sendMessage).not.toHaveBeenCalledWith(TAB, { type: "STATUS", status: "error" });
    expect(mock.badges.get(TAB)?.text).not.toBe("");
  });

  it("invalid report from backend → the on-device verdict, never the invalid body", async () => {
    const h = createHandlers({ fetchImpl: (async () => jsonResponse({ nope: true })) as typeof fetch });
    const r = await h.analyze(req(), TAB);
    expect(r.ok).toBe(true);
    expect(r.report?.stats.usedLlm).toBe(false);
    expect(mock.local.data()["report:" + DOMAIN]).toBeUndefined();
  });
});

describe("LOCAL_FINDINGS + GET_STATE", () => {
  it("stores fees locally for the popup and never calls the network", async () => {
    const fetchImpl = vi.fn();
    const h = createHandlers({ fetchImpl });
    const fees = { currency: "USD", lines: [{ label: "Service fee", amount: 4.95, kind: "extra_fee" as const }], extrasTotal: 4.95 };
    await h.handle({ type: MSG.LOCAL_FINDINGS, fees, darkPatterns: [{ kind: "prechecked_addon", label: "Protection plan" }] }, sender);
    expect(fetchImpl).not.toHaveBeenCalled();
    const s = await h.getState(TAB);
    expect(s.fees).toEqual(fees);
    expect(s.darkPatterns).toHaveLength(1);
  });

  it("GET_STATE includes the domain's report when the tab is ready", async () => {
    const report = await reportFor();
    const h = createHandlers({ fetchImpl: (async () => jsonResponse(report)) as unknown as typeof fetch });
    await h.analyze(req(), TAB);
    const s = await h.handle({ type: MSG.GET_STATE, tabId: TAB }, {} as chrome.runtime.MessageSender);
    expect(s).toMatchObject({ status: "ready", report: { verdict: "red" } });
  });
});

describe("FETCH_HTML", () => {
  it("fetches with credentials omitted", async () => {
    const fetchImpl = vi.fn(async (_u: string, _i?: RequestInit) => new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await h.handle({ type: MSG.FETCH_HTML, url: "https://legal.example/terms" }, sender);
    expect(r).toMatchObject({ ok: true, html: "<p>hi</p>", status: 200 });
    expect(fetchImpl.mock.calls[0][1]?.credentials).toBe("omit");
  });

  it("refuses non-http URLs, oversize bodies and errors", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 10);
    const h = createHandlers({ fetchImpl: (async () => new Response(big, { headers: { "content-type": "text/html" } })) as typeof fetch });
    const tab = "https://shop.example/checkout";
    expect(await h.fetchHtml("file:///etc/passwd", tab)).toMatchObject({ ok: false });
    expect(await h.fetchHtml("http://x.example/", tab)).toMatchObject({ ok: false });
    const h404 = createHandlers({ fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch });
    expect(await h404.fetchHtml("http://x.example/", tab)).toMatchObject({ ok: false, status: 404 });
  });

  it("times out after 10 s", async () => {
    vi.useFakeTimers();
    const fetchImpl = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = h.fetchHtml("http://slow.example/", "https://shop.example/checkout");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await p).toMatchObject({ ok: false });
    vi.useRealTimers();
  });
});

describe("SCAN_TAB", () => {
  it("asks the tab to scan; injects the content script if it isn't there", async () => {
    const h = createHandlers({ fetchImpl: vi.fn() });
    mock.chrome.tabs.sendMessage.mockRejectedValueOnce(new Error("no receiver")).mockResolvedValueOnce({ ok: true });
    const r = await h.handle({ type: MSG.SCAN_TAB, tabId: TAB }, {} as chrome.runtime.MessageSender);
    expect(r).toEqual({ ok: true });
    expect(mock.chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: TAB }, files: ["content.js"] });
    expect(mock.chrome.tabs.sendMessage).toHaveBeenLastCalledWith(TAB, { type: "SCAN_CURRENT_PAGE" });
  });
});

describe("badgeFor", () => {
  it("maps verdicts", () => {
    expect(badgeFor(SAMPLE_REPORT_RED, "ready").text).toBe("!4");
    expect(badgeFor({ ...SAMPLE_REPORT_RED, verdict: "yellow", flags: SAMPLE_REPORT_RED.flags.slice(0, 2) }, "ready").text).toBe("2");
    expect(badgeFor(SAMPLE_REPORT_GREEN, "ready").text).toBe("✓");
    expect(badgeFor({ ...SAMPLE_REPORT_GREEN, verdict: "unknown" }, "ready").text).toBe("?");
    expect(badgeFor(undefined, "idle").text).toBe("");
  });
});
