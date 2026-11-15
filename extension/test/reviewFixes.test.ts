/** Regression tests for the independent review's findings (one block per item). */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AnalyzeRequestSchema,
  DEFAULT_SETTINGS,
  ReportSchema,
  SAMPLE_REPORT_GREEN,
  SAMPLE_REPORT_RED,
  type Message,
  type Report,
} from "@xcavate/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureUrl, loadFixture } from "../../fixtures/load";
import { createHandlers } from "../src/background/handlers";
import { MAX_POLICY_HASHES, getPolicyHash, setPolicyHash } from "../src/background/state";
import { CARD_HOST_ID, Card, coverage } from "../src/content/card";
import { classify } from "../src/content/classifier";
import { collectPolicies, fetchPolicyHtml } from "../src/content/collect";
import { DarkPatternMarkers, findDarkPatterns } from "../src/content/darkPatterns";
import { classifyFeeLabel, detectFees } from "../src/content/fees";
import { SCAN_REFUSED, startContent } from "../src/content/index";
import { findPolicies, findPolicyCandidates } from "../src/content/policyFinder";
import { buildTrialReminder, fold } from "../src/lib/actions";
import { parseAllAmounts, parseAmount } from "../src/lib/money";
import { isFetchAllowed, isInternalHost } from "../src/lib/netguard";
import { buildAnalyzeRequest } from "../src/lib/request";
import { renderPopup } from "../src/popup/render";
import { installChromeMock } from "./chromeMock";
import { htmlDoc, setLiveDocument } from "./helpers";

const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const POLICY = `<p>${"You can return items within 30 days for a refund. ".repeat(20)}</p>`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("1. SSRF guard", () => {
  it("classifies internal hosts", () => {
    for (const h of ["localhost", "streamnest.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:7f00:1]", "printer.local", "wiki.corp.internal", "router"])
      expect(isInternalHost(h), h).toBe(true);
    for (const h of ["shop.example", "8.8.8.8", "172.32.0.1", "[2606:4700::1111]", "legal.example.com"]) expect(isInternalHost(h), h).toBe(false);
  });

  it("public pages may not reach internal hosts; local pages (fixtures) may", () => {
    expect(isFetchAllowed("http://192.168.1.1/status", "https://evil.com/checkout")).toBe(false);
    expect(isFetchAllowed("http://2130706433/", "https://evil.com/checkout")).toBe(false); // 127.0.0.1 in decimal
    expect(isFetchAllowed("ftp://legal.example/terms", "https://evil.com/checkout")).toBe(false);
    expect(isFetchAllowed("https://legal.example/terms", "https://shop.example/checkout")).toBe(true);
    expect(isFetchAllowed("http://legal.localhost:4001/streamnest/terms", "http://streamnest.localhost:4000/checkout")).toBe(true);
    expect(isFetchAllowed("http://10.0.0.1/", undefined)).toBe(false);
  });

  it("the policy finder never collects intranet links from a public page", () => {
    const doc = htmlDoc('<a href="http://192.168.1.1/status">Terms</a><a href="http://router/terms">Terms</a><a href="/refunds">Refunds</a>', "https://evil.com/checkout");
    expect(findPolicies(doc, "https://evil.com/checkout")).toEqual([{ url: "https://evil.com/refunds", kind: "refund" }]);
  });

  describe("FETCH_HTML", () => {
    beforeEach(() => installChromeMock());
    it("refuses senders without a tab URL and internal targets from public tabs, without fetching", async () => {
      const fetchImpl = vi.fn(async () => html("<p>router admin</p>"));
      const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(await h.handle({ type: "FETCH_HTML", url: "https://legal.example/terms" }, {} as chrome.runtime.MessageSender)).toEqual({ ok: false });
      const sender = { tab: { id: 1, url: "https://evil.com/checkout" } } as chrome.runtime.MessageSender;
      expect(await h.handle({ type: "FETCH_HTML", url: "http://192.168.1.1/status" }, sender)).toEqual({ ok: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
    it("drops a public URL that redirected into the local network", async () => {
      const res = html("<p>secret</p>");
      Object.defineProperty(res, "url", { value: "http://169.254.169.254/latest/meta-data" });
      const h = createHandlers({ fetchImpl: (async () => res) as typeof fetch });
      const r = await h.fetchHtml("https://evil.com/terms", "https://evil.com/checkout");
      expect(r.ok).toBe(false);
      expect(r.html).toBeUndefined();
    });
  });
});

describe("2. Policy URLs never carry query strings out", () => {
  it("finder keys by origin + path; the full URL is only used to fetch", () => {
    const doc = htmlDoc('<a href="/terms?session_id=SECRET&email=a@b.c#x">Terms</a>', "https://s.com/checkout");
    expect(findPolicies(doc, "https://s.com/checkout")).toEqual([
      { url: "https://s.com/terms", kind: "terms", fetchUrl: "https://s.com/terms?session_id=SECRET&email=a@b.c" },
    ]);
  });

  it("collect fetches the full URL but sends the stripped one (also after redirects)", async () => {
    const doc = htmlDoc('<a href="/terms?token=SECRET">Terms</a>', "https://s.com/checkout");
    const fetchHtml = vi.fn(async () => ({ html: POLICY, finalUrl: "https://legal.s.com/terms?lang=en&uid=42#top" }));
    const req = await collectPolicies(doc, "https://s.com/checkout", "checkout", { fetchHtml });
    expect(fetchHtml).toHaveBeenCalledWith("https://s.com/terms?token=SECRET", "https://s.com/checkout");
    expect(req.policies[0].url).toBe("https://legal.s.com/terms");
    expect(JSON.stringify(req)).not.toMatch(/SECRET|uid=42/);
  });

  it("buildAnalyzeRequest strips policy URLs centrally", () => {
    const r = buildAnalyzeRequest({ pageUrl: "https://s.com/c?x=1", pageType: "checkout", linksFound: 1, policies: [{ url: "https://s.com/t?sid=1#a", kind: "terms", text: "" }] });
    expect(r.policies[0].url).toBe("https://s.com/t");
  });

  it("shared schemas reject query/hash policy URLs and non-http report URLs", () => {
    const base = { pageUrl: "https://s.com/c", pageType: "checkout", linksFound: 1 };
    expect(AnalyzeRequestSchema.safeParse({ ...base, policies: [{ url: "https://s.com/t?sid=1", kind: "terms", text: "" }] }).success).toBe(false);
    expect(AnalyzeRequestSchema.safeParse({ ...base, policies: [{ url: "https://s.com/t", kind: "terms", text: "" }] }).success).toBe(true);
    const bad: Report = { ...SAMPLE_REPORT_RED, flags: [{ ...SAMPLE_REPORT_RED.flags[0], policyUrl: "javascript:alert(1)" }] };
    expect(ReportSchema.safeParse(bad).success).toBe(false);
    expect(ReportSchema.safeParse({ ...SAMPLE_REPORT_GREEN, policies: [{ ...SAMPLE_REPORT_GREEN.policies[0], url: "data:text/html,x" }] }).success).toBe(false);
    expect(ReportSchema.safeParse(SAMPLE_REPORT_RED).success).toBe(true);
  });

  it("hash:<url> keys are query-less and capped", async () => {
    const { local } = installChromeMock();
    await setPolicyHash("https://s.com/terms?sid=SECRET", "a".repeat(64));
    expect(Object.keys(local.data())).toContain("hash:https://s.com/terms");
    expect(Object.keys(local.data()).join()).not.toContain("SECRET");
    expect(await getPolicyHash("https://s.com/terms")).toBe("a".repeat(64));
    for (let i = 0; i < MAX_POLICY_HASHES + 5; i++) await setPolicyHash(`https://s${i}.com/t`, "b".repeat(64));
    const keys = Object.keys(local.data()).filter((k) => k.startsWith("hash:"));
    expect(keys.length).toBe(MAX_POLICY_HASHES);
    expect(keys).not.toContain("hash:https://s.com/terms"); // oldest evicted
  });
});

/** Content harness: chrome mock answering like the service worker. */
function content(site: "gadgetly" | "sneakyterms" | "streamnest", page: string, path: string, replies: Partial<Record<Message["type"], (m: Message) => unknown>> = {}) {
  const mock = installChromeMock();
  const sent: Message[] = [];
  mock.chrome.runtime.sendMessage.mockImplementation(async (m: unknown) => {
    const msg = m as Message;
    sent.push(msg);
    const fn = replies[msg.type];
    if (fn) return fn(msg);
    if (msg.type === "ANALYZE") return { ok: true, report: SAMPLE_REPORT_RED };
    if (msg.type === "PAGE_READY") return {};
    return { ok: true };
  });
  vi.stubGlobal("fetch", vi.fn(async () => html(POLICY)));
  history.replaceState({}, "", path);
  setLiveDocument(loadFixture(site, page));
  window.__xcavateLoaded = false;
  startContent(window);
  return { mock, sent };
}

describe("3. Scan this page refuses checkout pages", () => {
  it("content replies ok:false with the explanation and sends nothing", async () => {
    const { mock, sent } = content("gadgetly", "checkout", "/checkout");
    await vi.waitFor(() => expect(sent.some((m) => m.type === "ANALYZE")).toBe(true));
    const before = sent.length;
    const sendResponse = vi.fn();
    mock.listeners[0]({ type: "SCAN_CURRENT_PAGE" }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: SCAN_REFUSED });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.slice(before).some((m) => m.type === "ANALYZE")).toBe(false);
  });

  it("service worker passes the refusal to the popup", async () => {
    const mock = installChromeMock();
    mock.chrome.tabs.sendMessage.mockResolvedValueOnce({ ok: false, error: SCAN_REFUSED });
    const r = await createHandlers({ fetchImpl: vi.fn() }).scanTab(3);
    expect(r).toEqual({ ok: false, error: SCAN_REFUSED });
  });

  it("popup footer says what Scan sends", () => {
    document.body.innerHTML = "<main id=app></main>";
    const root = document.getElementById("app")!;
    renderPopup(root, { settings: DEFAULT_SETTINGS, state: { status: "idle" } }, { scan() {}, setEnabled() {}, setPaused() {}, saveApiBase() {}, downloadIcs() {} });
    expect(root.querySelector("footer")?.textContent).toContain("Scan this page also sends the text and address of the page you scan");
  });
});

describe("4. Malformed URLs and failed runs", () => {
  it("a malformed %-escape does not throw", () => {
    const doc = htmlDoc('<a href="/caf%E9">Shop</a><a href="/sale/50%-off">Sale</a><a href="/terms">Terms</a>', "https://s.com/checkout");
    expect(() => findPolicyCandidates(doc, "https://s.com/checkout")).not.toThrow();
    expect(findPolicies(doc, "https://s.com/checkout")).toEqual([{ url: "https://s.com/terms", kind: "terms" }]);
  });

  it("a failure after PAGE_READY sends STATUS error so the tab leaves 'checking'", async () => {
    // Make policy extraction crash mid-run (after PAGE_READY was answered).
    const { sent } = content("streamnest", "checkout", "/checkout");
    vi.stubGlobal("DOMParser", class { parseFromString() { throw new Error("parser crashed"); } });
    await vi.waitFor(() => expect(sent.some((m) => m.type === "STATUS" && m.status === "error")).toBe(true));
    expect(sent.some((m) => m.type === "ANALYZE")).toBe(false);
    expect(document.getElementById(CARD_HOST_ID)).toBeNull();
  });

  it("service worker moves a checking tab to error on STATUS from content", async () => {
    const mock = installChromeMock();
    await mock.session.set({ "tab:5": { status: "checking", domain: "s.com" } });
    await createHandlers({ fetchImpl: vi.fn() }).handle({ type: "STATUS", status: "error" }, { tab: { id: 5 } } as chrome.runtime.MessageSender);
    expect(mock.session.data()["tab:5"]).toMatchObject({ status: "error" });
    expect(mock.badges.get(5)?.text).toBe("");
  });
});

describe("5. Classifier false positives", () => {
  const blog = "<header><button>Subscribe</button></header><article>news</article>";
  for (const u of ["https://news.com/2026/border-crisis", "https://news.com/payments-industry-trends", "https://blog.com/how-to-reorder-items", "https://news.com/cartoons", "https://news.com/billing-scandal", "https://site.com/joint-pain"])
    it(`${u} is none`, () => expect(classify(htmlDoc(blog), u).pageType).toBe("none"));

  it("a search box named search-card is not a card field", () => {
    expect(classify(htmlDoc('<input name="search-card"><button>Sign up</button>'), "https://news.com/").pageType).toBe("none");
  });

  it("a bare newsletter Subscribe button does not count; a plan price makes it count", () => {
    expect(classify(htmlDoc("<p>Weekly letter</p><button>Subscribe</button><p>Total readers: 5</p>"), "https://x.com/news").signals).not.toContain("signup-button");
    expect(classify(htmlDoc("<p>$9.99/month after your 7-day free trial</p><button>Start free trial</button>"), "https://x.com/").signals).toContain("signup-button");
  });

  it("all 4 fixture checkouts and the ShopApp checkout view still qualify", () => {
    for (const s of ["streamnest", "gadgetly", "fairbox", "sneakyterms"] as const) {
      const url = fixtureUrl(s, "checkout");
      expect(classify(htmlDoc(loadFixture(s, "checkout"), url), url).pageType, s).not.toBe("none");
    }
    const tpl = htmlDoc(loadFixture("shopapp", "index")).querySelector("template")!.innerHTML;
    expect(classify(htmlDoc(tpl), "http://shopapp.localhost:4000/checkout").pageType).toBe("checkout");
  });
});

describe("6. The shopper's own ticks are never flagged", () => {
  it("a box ticked by the user after load is not a pre-checked add-on", () => {
    setLiveDocument('<body><label><input type="checkbox" id="w"> Add warranty ($19.99)</label></body>');
    expect(findDarkPatterns(document)).toEqual([]);
    (document.getElementById("w") as HTMLInputElement).click();
    expect(findDarkPatterns(document)).toEqual([]);
  });
});

describe("7. Late replies don't overwrite a tab that navigated away", () => {
  it("ANALYZE for page A arriving after PAGE_READY for page B leaves B's state and badge alone", async () => {
    const mock = installChromeMock();
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn((u: string) => (String(u).includes("/v1/report") ? Promise.resolve(new Response("", { status: 404 })) : new Promise<Response>((r) => (resolve = r))));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await h.pageReady({ type: "PAGE_READY", pageType: "checkout", score: 9, url: "https://a.com/checkout" }, 9);
    const pending = h.analyze({ pageUrl: "https://a.com/checkout", pageType: "checkout", linksFound: 1, policies: [{ url: "https://a.com/terms", kind: "terms", text: "x".repeat(600) }] }, 9);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    await h.pageReady({ type: "PAGE_READY", pageType: "none", score: 0, url: "https://b.com/blog" }, 9);
    resolve(new Response(JSON.stringify({ ...SAMPLE_REPORT_RED, domain: "a.com" }), { status: 200, headers: { "content-type": "application/json" } }));
    expect((await pending).ok).toBe(true);
    expect(mock.session.data()["tab:9"]).toMatchObject({ status: "idle", pageUrl: "https://b.com/blog" });
    expect(mock.badges.get(9)?.text).toBe("");
  });
});

describe("8. Same-origin fetch that fails (cross-origin redirect) falls back to the service worker", () => {
  it("retries through FETCH_HTML on a network error, not on a 404", async () => {
    const mock = installChromeMock();
    mock.chrome.runtime.sendMessage.mockResolvedValue({ ok: true, html: POLICY, status: 200, finalUrl: "https://legal.other.com/terms" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const page = await fetchPolicyHtml("https://s.com/terms", "https://s.com/checkout");
    expect(page?.finalUrl).toBe("https://legal.other.com/terms");
    expect(mock.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "FETCH_HTML", url: "https://s.com/terms" });

    mock.chrome.runtime.sendMessage.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(await fetchPolicyHtml("https://s.com/terms", "https://s.com/checkout")).toBeUndefined();
    expect(mock.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe("9. Fee labels and amounts", () => {
  it.each([
    ["Total fees", "extra_fee"],
    ["Item protection", "extra_fee"],
    ["Service fee (incl. VAT)", "extra_fee"],
    ["Taxes & fees", "extra_fee"],
    ["Total savings", "discount"],
    ["Order processing fee", "extra_fee"],
    ["Shipping & handling", "shipping"],
    ["Total", "total"],
    ["Order total", "total"],
    ["Total (USD)", "total"],
  ])("%s → %s", (label, kind) => expect(classifyFeeLabel(label)).toBe(kind));

  it("parses tricky amounts", () => {
    expect(parseAllAmounts("Qty 2 €12,50").map((a) => [a.amount, a.currency])).toEqual([[12.5, "EUR"]]);
    expect(parseAmount("TOTAL$12.00")).toMatchObject({ amount: 12, raw: "$12.00" });
    expect(parseAmount("Shipping 1 299,00 €")).toMatchObject({ amount: 1299, currency: "EUR" });
    expect(parseAmount("C$5.00")).toMatchObject({ amount: 5, currency: "CAD" });
  });

  it("'Total fees' is a fee, not the total", () => {
    const f = detectFees(htmlDoc("<div><p>Subtotal $50.00</p><p>Total fees $9.00</p><p>Shipping $5.00</p><p>Total $64.00</p></div>"))!;
    expect(f.extrasTotal).toBe(9);
    expect(f.lines.find((l) => l.kind === "total")?.amount).toBe(64);
  });
});

describe("10. Overlay never widens the page; SPA re-runs refetch nothing", () => {
  it("clamps markers to the page width", () => {
    setLiveDocument('<body><label id="l"><input type="checkbox" checked> Add insurance ($5)</label></body>');
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 800 });
    document.getElementById("l")!.getBoundingClientRect = () => ({ left: 700, top: 10, width: 400, height: 20, right: 1100, bottom: 30, x: 700, y: 10, toJSON() {} }) as DOMRect;
    const m = new DarkPatternMarkers(document, "open");
    m.mark(findDarkPatterns(document));
    const box = m.shadow.querySelector<HTMLElement>(".mark")!;
    expect(parseFloat(box.style.left) + parseFloat(box.style.width)).toBeLessThanOrEqual(800);
    m.destroy();
  });

  it("collect reuses cached pages across runs", async () => {
    const doc = htmlDoc('<a href="/terms">Terms</a>', "https://s.com/checkout");
    const fetchHtml = vi.fn(async () => POLICY);
    const cache = new Map();
    await collectPolicies(doc, "https://s.com/checkout", "checkout", { fetchHtml, cache });
    await collectPolicies(doc, "https://s.com/checkout", "checkout", { fetchHtml, cache });
    expect(fetchHtml).toHaveBeenCalledTimes(1);
  });
});

describe("11. Dismissal is kept by the service worker, not the page", () => {
  it("SET_DISMISSED is per tab + domain and comes back in PAGE_READY", async () => {
    installChromeMock();
    const h = createHandlers({ fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch });
    const sender = { tab: { id: 4, url: "https://shop.example/checkout?x=1" } } as chrome.runtime.MessageSender;
    await h.handle({ type: "SET_DISMISSED", dismissed: true }, sender);
    expect(await h.pageReady({ type: "PAGE_READY", pageType: "checkout", score: 9, url: "https://shop.example/checkout" }, 4)).toMatchObject({ dismissed: true });
    expect(await h.pageReady({ type: "PAGE_READY", pageType: "checkout", score: 9, url: "https://other.example/checkout" }, 4)).not.toHaveProperty("dismissed");
    expect(await h.pageReady({ type: "PAGE_READY", pageType: "checkout", score: 9, url: "https://shop.example/checkout" }, 5)).not.toHaveProperty("dismissed");
  });

  it("closing the card messages the service worker and writes nothing to page storage", async () => {
    sessionStorage.clear();
    const { sent } = content("streamnest", "checkout", "/checkout");
    await vi.waitFor(() => expect(sent.some((m) => m.type === "ANALYZE")).toBe(true));
    // Escape only dismisses with focus in the card (the shadow root is closed, so focus the host).
    const host = document.getElementById(CARD_HOST_ID) as HTMLElement;
    host.tabIndex = -1;
    host.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(sent).toContainEqual({ type: "SET_DISMISSED", dismissed: true });
    expect(sessionStorage.length).toBe(0);
    expect(document.getElementById(CARD_HOST_ID)).toBeNull();
  });
});

describe("12. Trial reminders", () => {
  it("a 1-day trial reminds today and says tomorrow, never a past date", () => {
    const today = new Date(2026, 0, 31);
    const r = buildTrialReminder({ lengthDays: 1 }, "X", "", today)!;
    expect(r.date.toDateString()).toBe(today.toDateString());
    expect(r.title).toBe("X trial ends tomorrow: cancel or keep?");
    expect(r.daysBefore).toBe(1);
  });

  it(".ics lines are at most 75 UTF-8 octets and never split a character", () => {
    const r = buildTrialReminder({ lengthDays: 30 }, "Ünïcödé Störe… 日本語ショップ", "https://x.com/terms", new Date(2026, 0, 31))!;
    for (const line of r.ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      expect(line).not.toContain("�");
    }
    const long = "SUMMARY:" + "é".repeat(100);
    expect(fold(long).replace(/\r\n /g, "")).toBe(long);
  });
});

describe("14. content script stays zod-free", () => {
  const src = join(__dirname, "..", "src");
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
  it("content/ and lib/ import only @xcavate/shared/core", () => {
    for (const f of [...files(join(src, "content")), ...files(join(src, "lib"))].filter((f) => f.endsWith(".ts"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from "@xcavate\/shared"/);
    }
  });
  it.runIf(existsSync(join(__dirname, "..", "dist", "content.js")))("built content.js has no zod and is small", () => {
    const js = readFileSync(join(__dirname, "..", "dist", "content.js"), "utf8");
    expect(js).not.toContain("ZodError");
    expect(js.length).toBeLessThan(60_000);
  });
});

describe("15. Coverage is stated honestly", () => {
  const partial: Report = {
    ...SAMPLE_REPORT_GREEN,
    policies: [...SAMPLE_REPORT_GREEN.policies, { url: "https://fairbox.example/terms-full", kind: "terms", textHash: "e".repeat(64), status: "unreadable" }],
  };
  it("card says Read 2 of 3 and names what it couldn't read", () => {
    expect(coverage(partial)).toBe("Read 2 of 3 policies. Couldn't read the terms: open it and press Scan this page.");
    expect(coverage(SAMPLE_REPORT_GREEN)).toBeUndefined();
    setLiveDocument("<body></body>");
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(partial);
    expect(card.shadow.textContent).toContain("Read 2 of 3 policies");
    card.hide();
  });
  it("popup lists unreadable policies with a Scan hint", () => {
    document.body.innerHTML = "<main id=app></main>";
    const root = document.getElementById("app")!;
    renderPopup(root, { settings: DEFAULT_SETTINGS, state: { status: "ready", report: partial } }, { scan() {}, setEnabled() {}, setPaused() {}, saveApiBase() {}, downloadIcs() {} });
    expect(root.textContent).toContain("Read 2 of 3 policies.");
    expect(root.textContent).toContain("couldn't read: open it, then Scan this page");
  });
});

describe("Real-site retest: form changes and Show card", () => {
  it("a form added on the same address keeps the card and sends no new PAGE_READY or ANALYZE", async () => {
    const { sent } = content("streamnest", "checkout", "/checkout");
    await vi.waitFor(() => expect(sent.some((m) => m.type === "ANALYZE")).toBe(true));
    await vi.waitFor(() => expect(document.getElementById(CARD_HOST_ID)).not.toBeNull());
    const before = sent.filter((m) => m.type === "PAGE_READY" || m.type === "ANALYZE").length;
    const f = document.createElement("form");
    f.innerHTML = "<input type=search aria-label=search>";
    document.body.appendChild(f); // a newsletter or search widget appears
    await new Promise((r) => setTimeout(r, 4200)); // past the watcher's debounce and minimum gap
    expect(sent.filter((m) => m.type === "PAGE_READY" || m.type === "ANALYZE").length).toBe(before);
    expect(document.getElementById(CARD_HOST_ID)).not.toBeNull();
  }, 10_000);

  it("SHOW_CARD from the popup undoes a dismissal and re-runs", async () => {
    const { mock, sent } = content("streamnest", "checkout", "/checkout");
    await vi.waitFor(() => expect(sent.some((m) => m.type === "ANALYZE")).toBe(true));
    const sendResponse = vi.fn();
    mock.listeners[0]({ type: "SHOW_CARD" }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(sent).toContainEqual({ type: "SET_DISMISSED", dismissed: false });
    await vi.waitFor(() => expect(sent.filter((m) => m.type === "PAGE_READY").length).toBeGreaterThan(1));
  });
});
