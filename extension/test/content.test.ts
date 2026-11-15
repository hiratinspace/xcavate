import { SAMPLE_REPORT_RED, type AnalyzeRequest, type Message } from "@xcavate/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../../fixtures/load";
import { CARD_HOST_ID } from "../src/content/card";
import { collectPolicies, waitForDomQuiet } from "../src/content/collect";
import { startContent } from "../src/content/index";
import { installChromeMock } from "./chromeMock";
import { htmlDoc, setLiveDocument } from "./helpers";

/** Serve fixture HTML for a URL like http://localhost:3000/subscription (same origin in jsdom). */
function fixtureFor(site: "streamnest" | "gadgetly" | "fairbox" | "sneakyterms", url: string): string | undefined {
  const page = new URL(url).pathname.split("/").filter(Boolean).pop();
  try {
    return page ? loadFixture(site, page) : undefined;
  } catch {
    return undefined;
  }
}

type Reply = (msg: Message) => unknown;

function setup(site: "streamnest" | "gadgetly" | "fairbox" | "sneakyterms", reply: Partial<Record<Message["type"], Reply>> = {}) {
  const mock = installChromeMock();
  const sent: Message[] = [];
  mock.chrome.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
    const m = msg as Message;
    sent.push(m);
    const fn = reply[m.type];
    if (fn) return fn(m);
    if (m.type === "PAGE_READY") return {};
    if (m.type === "FETCH_HTML") {
      const html = fixtureFor(site, m.url);
      return html ? { ok: true, html, status: 200 } : { ok: false, status: 404 };
    }
    if (m.type === "ANALYZE") return { ok: true, report: SAMPLE_REPORT_RED };
    return { ok: true };
  });
  const fetchMock = vi.fn(async (url: string) => {
    const html = fixtureFor(site, url);
    return html ? new Response(html, { status: 200, headers: { "content-type": "text/html" } }) : new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  history.replaceState({}, "", "/checkout?promo=SECRET#pay");
  setLiveDocument(loadFixture(site, "checkout"));
  window.__xcavateLoaded = false;
  return { mock, sent, fetchMock };
}

const analyzeOf = (sent: Message[]) => sent.find((m) => m.type === "ANALYZE") as Extract<Message, { type: "ANALYZE" }> | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById(CARD_HOST_ID)?.remove();
  sessionStorage.clear();
});

describe("content orchestrator (D-06)", () => {
  beforeEach(() => sessionStorage.clear());

  it("StreamNest: classify → PAGE_READY → fetch (same + cross origin) → ANALYZE → card", async () => {
    const { sent } = setup("streamnest");
    startContent(window);
    await vi.waitFor(() => expect(analyzeOf(sent)).toBeDefined());
    const ready = sent.find((m) => m.type === "PAGE_READY") as Extract<Message, { type: "PAGE_READY" }>;
    expect(ready.pageType).toBe("checkout");
    expect(ready.url).toBe("http://localhost:3000/checkout");

    const req = analyzeOf(sent)!.request;
    expect(Object.keys(req).sort()).toEqual(["linksFound", "pageType", "pageUrl", "policies"]);
    expect(req.pageUrl).toBe("http://localhost:3000/checkout"); // query + hash stripped
    expect(req.policies.map((p) => p.kind)).toEqual(["subscription", "terms", "privacy"]);
    expect(req.policies.every((p) => p.text.length >= 500)).toBe(true);
    expect(req.policies[0].text).toContain("renews automatically each month until you cancel");
    // The cross-origin terms page went through the service worker.
    expect(sent.some((m) => m.type === "FETCH_HTML" && m.url === "http://legal.localhost:4001/streamnest/terms")).toBe(true);
    expect(JSON.stringify(req)).not.toContain("SECRET");
    expect(document.getElementById(CARD_HOST_ID)).not.toBeNull();
  });

  it("Gadgetly: local findings go to bg only and never ride along in ANALYZE", async () => {
    const { sent } = setup("gadgetly");
    startContent(window);
    await vi.waitFor(() => expect(analyzeOf(sent)).toBeDefined());
    const local = sent.find((m) => m.type === "LOCAL_FINDINGS") as Extract<Message, { type: "LOCAL_FINDINGS" }>;
    expect(local.fees?.extrasTotal).toBe(17.94);
    expect(local.darkPatterns?.map((d) => d.kind)).toEqual(["prechecked_addon", "preselected_subscription"]);
    const body = JSON.stringify(analyzeOf(sent)!.request);
    expect(body).not.toContain("extrasTotal");
    expect(body).not.toContain("prechecked");
    expect(body).not.toContain("Protection plan (+$12.99)");
    // The pre-checked box is still checked: we never touch inputs.
    expect((document.getElementById("protection") as HTMLInputElement).checked).toBe(true);
  });

  it("refreshes local findings after extras are removed without another policy scan", async () => {
    const { sent } = setup("gadgetly");
    startContent(window);
    await vi.waitFor(() => expect(analyzeOf(sent)).toBeDefined());
    const count = sent.filter((m) => m.type === "ANALYZE").length;
    const protection = document.getElementById("protection") as HTMLInputElement;
    protection.checked = false;
    // A shop can render its new summary after the control event has bubbled.
    setTimeout(() => {
      document.getElementById("protection-row")!.hidden = true;
      document.getElementById("total")!.textContent = "$151.26";
    }, 20);
    protection.dispatchEvent(new Event("change", { bubbles: true }));
    const subscription = document.getElementById("tips-subscribe") as HTMLInputElement;
    const once = document.getElementById("tips-once") as HTMLInputElement;
    subscription.checked = false;
    once.checked = true;
    once.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      const local = sent.filter((m) => m.type === "LOCAL_FINDINGS").at(-1) as Extract<Message, { type: "LOCAL_FINDINGS" }>;
      expect(local.fees?.extrasTotal).toBe(4.95);
    });
    const latest = sent.filter((m) => m.type === "LOCAL_FINDINGS").at(-1) as Extract<Message, { type: "LOCAL_FINDINGS" }>;
    expect(latest.darkPatterns).toEqual([]);
    expect(latest.fees?.extrasTotal).toBe(4.95);
    expect(latest.fees?.lines.some((l) => l.label === "Protection plan")).toBe(false);
    expect(sent.filter((m) => m.type === "ANALYZE")).toHaveLength(count);
    expect(protection.checked).toBe(false);
    expect(once.checked).toBe(true);
  });

  it("backend error → card removed silently, page untouched", async () => {
    const { sent } = setup("fairbox", { ANALYZE: () => ({ ok: false, error: "backend 500" }) });
    const before = document.body.innerHTML;
    startContent(window);
    await vi.waitFor(() => expect(analyzeOf(sent)).toBeDefined());
    await vi.waitFor(() => expect(document.getElementById(CARD_HOST_ID)).toBeNull());
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelector("#xcavate-marks-host")?.remove();
    expect(clone.innerHTML).toBe(before);
  });

  it("paused site → no card, no fetches, no ANALYZE", async () => {
    const { sent, fetchMock } = setup("streamnest", { PAGE_READY: () => ({ paused: true }) });
    startContent(window);
    await vi.waitFor(() => expect(sent.some((m) => m.type === "PAGE_READY")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(analyzeOf(sent)).toBeUndefined();
    expect(document.getElementById(CARD_HOST_ID)).toBeNull();
  });

  it("dismissed in this tab (kept by the service worker) → no card on the next run", async () => {
    const { sent } = setup("streamnest", { PAGE_READY: () => ({ dismissed: true }) });
    startContent(window);
    await vi.waitFor(() => expect(analyzeOf(sent)).toBeDefined());
    expect(document.getElementById(CARD_HOST_ID)).toBeNull();
  });

  it("SCAN_CURRENT_PAGE (D-05): live page as one 'other' policy with pageType none", async () => {
    const { mock, sent } = setup("sneakyterms");
    history.replaceState({}, "", "/terms?ref=mail");
    setLiveDocument(loadFixture("sneakyterms", "terms"));
    startContent(window);
    await new Promise((r) => setTimeout(r, 10));
    const listener = mock.listeners[0];
    const sendResponse = vi.fn();
    listener({ type: "SCAN_CURRENT_PAGE" }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await vi.waitFor(() => expect(sent.filter((m) => m.type === "ANALYZE").length).toBeGreaterThan(0));
    const req = (sent.filter((m) => m.type === "ANALYZE").pop() as Extract<Message, { type: "ANALYZE" }>).request;
    expect(req.pageType).toBe("none");
    expect(req.policies).toHaveLength(1);
    expect(req.policies[0]).toMatchObject({ kind: "other", url: "http://localhost:3000/terms" });
    expect(req.policies[0].text).toContain("All sales are final");
    expect(req.policies[0].text).not.toContain("SYSTEM OVERRIDE");
  });
});

describe("collectPolicies", () => {
  it("falls back to well-known paths when no links exist, and counts them as found", async () => {
    const doc = htmlDoc("<p>Checkout</p>", "https://shop.example/checkout");
    const fetchHtml = vi.fn(async (u: string) => (u.endsWith("/refund-policy") ? `<p>${"Refunds within 30 days. ".repeat(40)}</p>` : undefined));
    const req: AnalyzeRequest = await collectPolicies(doc, "https://shop.example/checkout", "checkout", { fetchHtml });
    expect(req.policies).toHaveLength(1);
    expect(req.policies[0]).toMatchObject({ url: "https://shop.example/refund-policy", kind: "refund" });
    expect(req.linksFound).toBe(1);
  });

  it("uses the final URL after redirects as the policy URL, de-duplicating links that land on one page", async () => {
    const doc = htmlDoc(`<a href="/old-terms">Terms</a><a href="/promo-terms">Offer terms</a>`, "https://shop.example/checkout");
    const page = `<p>${"Your plan renews every month until you cancel. ".repeat(20)}</p>`;
    const req = await collectPolicies(doc, "https://shop.example/checkout", "checkout", {
      fetchHtml: async () => ({ html: page, finalUrl: "https://legal.shop.example/paid-terms" }),
    });
    expect(req.policies.map((p) => p.url)).toEqual(["https://legal.shop.example/paid-terms"]);
  });

  it("retries once after the DOM settles when the first pass finds no links (JS-rendered pages)", async () => {
    const doc = htmlDoc("<div id=root></div>", "https://shop.example/checkout");
    const settle = vi.fn(async () => {
      doc.getElementById("root")!.innerHTML = `<footer><a href="/terms">Terms of Service</a></footer>`;
    });
    const fetchHtml = vi.fn(async () => `<p>${"Terms text. ".repeat(60)}</p>`);
    const req = await collectPolicies(doc, "https://shop.example/checkout", "checkout", { fetchHtml, settle });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(req.policies.map((p) => p.url)).toEqual(["https://shop.example/terms"]);
  });

  it("waitForDomQuiet resolves after a quiet period, capped by maxMs", async () => {
    vi.useFakeTimers();
    let done = false;
    void waitForDomQuiet(document, 1000, 4000).then(() => (done = true));
    const tick = setInterval(() => document.body.appendChild(document.createElement("i")), 300);
    await vi.advanceTimersByTimeAsync(3900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
    clearInterval(tick);
    vi.useRealTimers();
  });

  it("sends unreadable policies with empty text so the backend can mark them", async () => {
    const doc = htmlDoc(`<a href="/terms">Terms</a>`, "https://shop.example/checkout");
    const req = await collectPolicies(doc, "https://shop.example/checkout", "checkout", { fetchHtml: async () => "<div id=root></div>" });
    expect(req.policies).toEqual([{ url: "https://shop.example/terms", kind: "terms", text: "" }]);
    expect(req.linksFound).toBe(1);
  });
});
