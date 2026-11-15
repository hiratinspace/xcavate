/**
 * Direction v3, detection lane: regression tests for the real-site test findings (27 real pages in
 * Chromium). 1: the card fired on 4 of ~16 plan/checkout pages. 2: the policy finder picked cookie
 * notices, product collections and billing apps. 3: the card covered page controls. 4: a re-render
 * dropped keyboard focus. Fixture pages copy the structure of the real sites, not their text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISCLAIMER, SAMPLE_REPORT_GREEN, SAMPLE_REPORT_RED, type Report } from "@xcavate/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATTERN_PAGES, fixtureUrl, loadFixture } from "../../fixtures/load";
import { Card, type CardPrefs } from "../src/content/card";
import { classify, watchForLateQualify, type Classification } from "../src/content/classifier";
import { findPolicies, findPolicyCandidates } from "../src/content/policyFinder";
import { htmlDoc, setLiveDocument } from "./helpers";

const kinds = (doc: Document, url: string) => findPolicies(doc, url).map((p) => `${p.kind} ${p.url}`);
const PLANS = "https://example.com/plans";
const page = (html: string, url = PLANS) => htmlDoc(html, url);

describe("1. Classifier: real plan, trial and checkout pages qualify", () => {
  for (const [page, want] of Object.entries(PATTERN_PAGES)) {
    if (page === "plans-hydrated") continue;
    it(`${page} → ${want.pageType}`, () => {
      expect(classify(htmlDoc(loadFixture("pages", page), want.url), want.url).pageType).toBe(want.pageType);
    });
  }

  it.each([
    "Try 1 month for $0",
    "Try for $0.00",
    "Get started",
    "Start free trial",
    "Start your free trial",
    "Get Premium",
    "Choose plan",
    "Select plan",
    "Subscribe",
    "Join now",
    "Continue to checkout",
    "Continue to payment",
    "Proceed to checkout",
    "Sign up",
    "Free Trial",
  ])("link CTA %s next to a plan price qualifies", (cta) => {
    const url = "https://app.example/features";
    const doc = htmlDoc(`<main><div class="tier"><h3>Pro</h3><p><b>$11.99</b><span>/mo</span></p><a class="btn" href="/go">${cta}</a></div></main>`, url);
    expect(classify(doc, url).pageType).not.toBe("none");
  });

  it.each([
    "$10 per seat/month",
    "$12 USD / month",
    "$11.99/mo",
    "US$9.99 a month",
    "€9,99/Monat",
    "£5 per user per month",
    "$99/yr",
    "$120, billed annually",
    "Monthly price $7.99",
    "7-day free trial",
  ])("plan price %s in a pricing card qualifies", (price) => {
    const url = "https://tool.example/";
    const doc = htmlDoc(`<main><section><h2>Team</h2><p>${price}</p><a href="/buy">Get started</a></section></main>`, url);
    const r = classify(doc, url);
    expect(r.signals).toContain("plan-price");
    expect(r.pageType).toBe("signup");
  });

  it("counts <a role=button>, <input type=submit> captions (attribute, not typed values) and buttons", () => {
    const url = "https://tool.example/offer";
    for (const cta of [`<a role="button" href="/x">Subscribe</a>`, `<input type="submit" value="Start free trial">`, `<button>Get Premium</button>`]) {
      const doc = htmlDoc(`<main><div><p>$8/month</p>${cta}</div></main>`, url);
      expect(classify(doc, url).pageType, cta).toBe("signup");
    }
  });

  it("plan path words score (pricing, premium, membership, subscription, trial, upgrade)", () => {
    for (const seg of ["pricing", "premium", "membership", "subscription", "trial", "upgrade"]) {
      expect(classify(htmlDoc("<p>x</p>"), `https://x.example/${seg}`).signals, seg).toContain("path:plans");
    }
    expect(classify(htmlDoc("<p>x</p>"), "https://x.example/premium-cars-review").signals).not.toContain("path:plans");
  });

  it("a cart with items and a total is a checkout; an empty cart is silent", () => {
    const full = htmlDoc(`<main><table><tr><td>Subtotal</td><td>$42.00</td></tr></table><a href="/checkout">Proceed to checkout</a></main>`);
    expect(classify(full, "https://shop.example/cart").pageType).toBe("checkout");
    const empty = htmlDoc(
      `<header><a href="/account/register">Create account</a></header><main><h1>Your cart is empty</h1><a href="/">Continue shopping</a></main>
       <aside><p>Subtotal <span>$0.00</span></p><button>Check out</button></aside>`,
    );
    expect(classify(empty, "https://shop.example/cart").pageType).toBe("none");
  });

  it("stays silent: news story with prices in prose, docs page with Get started, homepage without a price", () => {
    const a = PATTERN_PAGES["article-4"];
    expect(classify(htmlDoc(loadFixture("pages", "article-4"), a.url), a.url).pageType).toBe("none");
    const d = PATTERN_PAGES["docs-1"];
    expect(classify(htmlDoc(loadFixture("pages", "docs-1"), d.url), d.url).pageType).toBe("none");
    const home = htmlDoc(`<header><a href="/signup">Sign up</a></header><main><h1>Notes for teams</h1><a class="btn" href="/signup">Get started</a></main>`);
    expect(classify(home, "https://notes.example/").pageType).toBe("none");
    // A single headline price far from any call to action is not a pricing card.
    const promo = htmlDoc(`<main><p>Plans from $9.99/mo</p><p>${"Lots of features. ".repeat(40)}</p><a href="/download">Get the app</a></main>`);
    expect(classify(promo, "https://notes.example/").pageType).toBe("none");
  });

  it("existing fixtures hold: four checkouts fire, product pages and articles stay silent", () => {
    for (const s of ["streamnest", "gadgetly", "fairbox", "sneakyterms"] as const) {
      const url = fixtureUrl(s, "checkout");
      expect(classify(htmlDoc(loadFixture(s, "checkout"), url), url).pageType, s).not.toBe("none");
      const home = fixtureUrl(s, "index");
      expect(classify(htmlDoc(loadFixture(s, "index"), home), home).pageType, s + " index").toBe("none");
    }
    const art = fixtureUrl("pages", "article-1");
    expect(classify(htmlDoc(loadFixture("pages", "article-1"), art), art).pageType).toBe("none");
  });
});

describe("1b. watchForLateQualify: client-rendered pricing pages qualify after load", () => {
  const P = PATTERN_PAGES["plans-hydrated"];
  const hydrate = () => {
    const tpl = document.getElementById("rendered") as HTMLTemplateElement;
    document.getElementById("app")!.replaceChildren(tpl.content.cloneNode(true));
  };
  beforeEach(() => {
    vi.useFakeTimers();
    setLiveDocument(loadFixture("pages", "plans-hydrated").replace(/<script>[\s\S]*?<\/script>/, ""));
  });
  afterEach(() => vi.useRealTimers());

  it("is none at load and signup once rendered", () => {
    expect(classify(document, P.url).pageType).toBe("none");
    hydrate();
    expect(classify(document, P.url).pageType).toBe("signup");
  });

  it("re-classifies once the DOM is quiet and calls onQualify once", async () => {
    const onQualify = vi.fn();
    const seen: string[] = [];
    const classifyFn = (d: Document): Classification => {
      const r = classify(d, P.url);
      seen.push(r.pageType);
      return r;
    };
    watchForLateQualify(window, onQualify, { classifyFn });
    hydrate();
    await vi.advanceTimersByTimeAsync(100);
    expect(onQualify).not.toHaveBeenCalled(); // waits for quiet (growth check fires after 500 ms)
    await vi.advanceTimersByTimeAsync(3000);
    expect(onQualify).toHaveBeenCalledTimes(1);
    expect(onQualify.mock.calls[0][0].pageType).toBe("signup");
    // Stopped: later mutations do nothing.
    document.body.appendChild(document.createElement("div"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onQualify).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["signup"]);
  });

  it("is bounded: at most maxChecks re-checks on a page that keeps changing, none without mutations", async () => {
    const classifyFn = vi.fn((): Classification => ({ pageType: "none", score: 0, signals: [] }));
    const stop = watchForLateQualify(window, vi.fn(), { classifyFn, quietMs: 1000, maxChecks: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(classifyFn).not.toHaveBeenCalled(); // nothing changed: nothing to re-check
    for (let i = 0; i < 40; i++) {
      document.body.appendChild(document.createElement("p"));
      await vi.advanceTimersByTimeAsync(1200);
    }
    expect(classifyFn).toHaveBeenCalledTimes(3);
    stop();
  });

  it("a page that never goes quiet is still checked, and stop() and maxMs end the watch", async () => {
    const classifyFn = vi.fn((): Classification => ({ pageType: "none", score: 0, signals: [] }));
    watchForLateQualify(window, vi.fn(), { classifyFn, quietMs: 1000, maxChecks: 5, maxMs: 20_000 });
    for (let i = 0; i < 50; i++) {
      document.body.appendChild(document.createElement("i")); // a ticking clock: every 400 ms
      await vi.advanceTimersByTimeAsync(400);
    }
    const calls = classifyFn.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(5);
    const after = classifyFn.mock.calls.length;
    document.body.appendChild(document.createElement("i"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(classifyFn.mock.calls.length).toBe(after); // past maxMs: stopped
  });
});

describe("2. Policy finder picks documents, not look-alikes", () => {
  it("SaaS pricing footer: documents in, cookie notice, business agreement, /legal/ index and help article out", () => {
    const url = PATTERN_PAGES["plans-saas"].url;
    expect(kinds(htmlDoc(loadFixture("pages", "plans-saas"), url), url)).toEqual([
      "subscription https://notely.example/legal/subscription-terms",
      "terms https://notely.example/legal/terms-of-service",
      "privacy https://notely.example/legal/privacy-policy",
    ]);
  });

  it("streaming premium page: paid terms first; billing app, manage-subscription, collections and products never", () => {
    const url = PATTERN_PAGES["trial-stream"].url;
    const got = kinds(htmlDoc(loadFixture("pages", "trial-stream"), url), url);
    expect(got[0]).toBe("terms https://streamly.example/legal/paid-subscription-terms/");
    expect(got).toContain("privacy https://streamly.example/legal/privacy-policy/");
    expect(got.join(" ")).not.toMatch(/commerce|manage-subscription|collections|products|cookies|legal\/ /);
    expect(got.every((g) => !g.endsWith("/legal/"))).toBe(true);
  });

  it("empty Shopify cart: refund and terms policies, not cookie, account or collection links", () => {
    const url = PATTERN_PAGES["cart-empty"].url;
    expect(kinds(htmlDoc(loadFixture("pages", "cart-empty"), url), url)).toEqual([
      "refund https://beanhouse.example/policies/refund-policy",
      "terms https://beanhouse.example/policies/terms-of-service",
    ]);
  });

  it("a cookies page is never the subscription policy, even under a billing path", () => {
    const doc = page(`<a href="https://help.example/accounts-billing/security/cookies">Cookies</a><a href="/terms">Terms</a>`);
    expect(kinds(doc, "https://example.com/plans")).toEqual(["terms https://example.com/terms"]);
    // A combined privacy and cookie policy is still the privacy policy.
    const both = page(`<a href="/privacy-and-cookies">Privacy and Cookie Policy</a>`);
    expect(kinds(both, "https://example.com/plans")).toEqual(["privacy https://example.com/privacy-and-cookies"]);
  });

  it("/legal/privacy-policy is privacy, not terms; enterprise and MSA links are skipped", () => {
    const doc = page(
      `<a href="/us/legal/privacy-policy/">Privacy</a><a href="/legal/enterprise-terms">Enterprise terms</a>
       <a href="/legal/msa">Master Services Agreement</a><a href="/terms/customer-business-agreement">Terms</a><a href="/terms">Terms</a>`,
    );
    expect(kinds(doc, "https://example.com/plans")).toEqual(["terms https://example.com/terms", "privacy https://example.com/us/legal/privacy-policy/"]);
  });

  it("link text that names a document beats a path match; documents beat index pages", () => {
    const doc = page(
      `<a href="/legal">Legal</a><a href="/hc/en-us">Help Center</a><a href="/info/billing-faq">Read more</a>
       <a href="/l/123">Terms of Use</a><a href="/l/456">Refund Policy</a><a href="/l/789">Privacy Notice</a>`,
    );
    expect(kinds(doc, "https://example.com/plans")).toEqual([
      "refund https://example.com/l/456",
      "terms https://example.com/l/123",
      "privacy https://example.com/l/789",
    ]);
  });

  it("weak links still fill in when the page has nothing better", () => {
    const doc = page(`<a href="/legal">Legal</a>`);
    expect(kinds(doc, "https://example.com/plans")).toEqual(["terms https://example.com/legal"]);
  });

  it("one privacy slot: money documents get the room", () => {
    const doc = page(
      `<a href="/privacy">Privacy Policy</a><a href="/privacy/california">California Privacy Notice</a><a href="/terms">Terms of Service</a><a href="/refunds">Refund Policy</a>`,
    );
    expect(findPolicies(doc, "https://example.com/plans").filter((p) => p.kind === "privacy")).toHaveLength(1);
  });

  it("the agreement sentence next to the pay button still wins over everything", () => {
    const doc = page(
      `<footer><a href="/subscription-terms">Subscription Terms</a></footer>
       <p>By placing your order you agree to our <a href="/legal">legal stuff</a>.</p>`,
    );
    const c = findPolicyCandidates(doc, "https://example.com/checkout");
    expect(c[0]).toMatchObject({ url: "https://example.com/legal", agree: true });
    expect(findPolicies(doc, "https://example.com/checkout").map((p) => p.url)).toContain("https://example.com/legal");
  });
});

describe("3. Card starts compact, expands on demand, can move", () => {
  beforeEach(() => setLiveDocument("<body><input id='field'></body>"));

  const cardEl = (c: Card) => c.shadow.querySelector(".card") as HTMLElement;
  const toggle = (c: Card) => c.shadow.querySelector(".toggle") as HTMLButtonElement;

  it("compact by default: verdict, headline (role=status), Show details, disclaimer; details hidden", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport({ ...SAMPLE_REPORT_RED, trial: undefined });
    expect(cardEl(card).dataset.expanded).toBe("false");
    expect(card.shadow.querySelector('[role="status"]')?.textContent).toBe("3 things to read before you pay");
    expect(toggle(card).textContent).toBe("Show details");
    expect(toggle(card).getAttribute("aria-expanded")).toBe("false");
    expect(toggle(card).getAttribute("aria-controls")).toBe("xc-details");
    expect(card.shadow.getElementById("xc-details")?.querySelectorAll(".flag")).toHaveLength(3);
    // The disclaimer sits outside the details, so it shows in both states.
    const disc = card.shadow.querySelector(".disclaimer")!;
    expect(disc.textContent).toBe(DISCLAIMER);
    expect(disc.closest(".details")).toBeNull();
  });

  it("the CSS hides details only while compact and keeps the compact card small", () => {
    const css = readFileSync(join(__dirname, "..", "src", "content", "card.css"), "utf8");
    expect(css).toMatch(/\.card\[data-expanded="false"\] \.details/);
    expect(css).toMatch(/\.card\[data-side="left"\] \{ right: auto; left: 16px/);
    // No side-tab accent borders: the quote rule is the one sanctioned exception.
    const accents = css.split("\n").filter((l) => /border-left:\s*[2-9]px solid/.test(l));
    expect(accents).toHaveLength(1);
    expect(accents[0]).toMatch(/^\.quote /);
  });

  it("the trial reminder stays visible while compact; the quote waits in the details", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(SAMPLE_REPORT_RED);
    const cal = card.shadow.querySelector(".remind a.primary")!;
    expect(cal.closest(".details")).toBeNull();
    expect(card.shadow.querySelector("blockquote")?.closest(".details")).not.toBeNull();
    expect(card.shadow.querySelector(".remind a[download]")?.closest(".details")).not.toBeNull();
  });

  it("toggle expands in place (same nodes, nothing re-announced) and reports the preference", () => {
    const onPrefsChange = vi.fn();
    const card = new Card(document, { shadowMode: "open", onPrefsChange });
    card.showReport({ ...SAMPLE_REPORT_RED, trial: undefined });
    const h = card.shadow.querySelector(".headline");
    toggle(card).click();
    expect(cardEl(card).dataset.expanded).toBe("true");
    expect(toggle(card).getAttribute("aria-expanded")).toBe("true");
    expect(toggle(card).textContent).toBe("Hide details");
    expect(card.shadow.querySelector(".headline")).toBe(h);
    expect(onPrefsChange).toHaveBeenLastCalledWith({ expanded: true, side: "right" });
    // The choice survives the next report.
    card.showReport({ ...SAMPLE_REPORT_RED, trial: undefined, verdict: "yellow" });
    expect(cardEl(card).dataset.expanded).toBe("true");
  });

  it("Enter/Space work because the toggle is a real button; move flips the side and reports it", () => {
    const onPrefsChange = vi.fn();
    const card = new Card(document, { shadowMode: "open", onPrefsChange });
    card.showReport(SAMPLE_REPORT_GREEN);
    expect(toggle(card).tagName).toBe("BUTTON");
    expect(toggle(card).getAttribute("type")).toBe("button");
    const move = card.shadow.querySelector(".move") as HTMLButtonElement;
    expect(move.getAttribute("aria-label")).toBe("Move the Xcavate card to the left side");
    move.click();
    expect(cardEl(card).dataset.side).toBe("left");
    expect(move.getAttribute("aria-label")).toBe("Move the Xcavate card to the right side");
    expect(onPrefsChange).toHaveBeenLastCalledWith({ expanded: false, side: "left" });
  });

  it("starting prefs and setPrefs (loaded later) apply without calling onPrefsChange", () => {
    const onPrefsChange = vi.fn();
    const card = new Card(document, { shadowMode: "open", prefs: { expanded: true, side: "left" }, onPrefsChange });
    card.showChecking("shop.example");
    expect(cardEl(card).dataset.expanded).toBe("true");
    expect(cardEl(card).dataset.side).toBe("left");
    card.setPrefs({ expanded: false, side: "right" });
    expect(cardEl(card).dataset.expanded).toBe("false");
    expect(card.preferences).toEqual<CardPrefs>({ expanded: false, side: "right" });
    expect(onPrefsChange).not.toHaveBeenCalled();
  });

  it("checking state has no empty details toggle but keeps the disclaimer", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showChecking("shop.example");
    expect(card.shadow.querySelector(".toggle")).toBeNull();
    expect(card.shadow.textContent).toContain(DISCLAIMER);
  });
});

describe("4. Card re-render keeps keyboard focus", () => {
  beforeEach(() => setLiveDocument("<body></body>"));

  it("focus on Remind me survives the backend report replacing the local one (same verdict, same headline node)", () => {
    const card = new Card(document, { shadowMode: "open" });
    const local: Report = { ...SAMPLE_REPORT_RED, stats: { ...SAMPLE_REPORT_RED.stats, usedLlm: false } };
    card.showReport(local);
    const h = card.shadow.querySelector(".headline");
    (card.shadow.querySelector('[data-xc-key="remind"]') as HTMLElement).focus();
    expect(card.shadow.activeElement?.getAttribute("data-xc-key")).toBe("remind");
    card.showReport(SAMPLE_REPORT_RED);
    expect(card.shadow.activeElement?.getAttribute("data-xc-key")).toBe("remind");
    expect(card.shadow.querySelector(".headline")).toBe(h);
  });

  it("focus on See in policy survives local findings arriving", () => {
    const card = new Card(document, { shadowMode: "open", prefs: { expanded: true } });
    card.showReport(SAMPLE_REPORT_RED);
    (card.shadow.querySelector('[data-xc-key="see"]') as HTMLElement).focus();
    card.setLocal({ darkPatterns: [{ kind: "prechecked_addon", label: "Protection plan" }] });
    expect(card.shadow.activeElement?.getAttribute("data-xc-key")).toBe("see");
  });

  it("when the focused control is gone, focus falls back to the toggle instead of the page", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(SAMPLE_REPORT_RED);
    (card.shadow.querySelector('[data-xc-key="remind"]') as HTMLElement).focus();
    card.showReport({ ...SAMPLE_REPORT_RED, trial: undefined });
    expect(card.shadow.activeElement?.getAttribute("data-xc-key")).toBe("toggle");
  });

  it("does not steal focus when nothing in the card had it", () => {
    setLiveDocument("<body><input id='f'></body>");
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(SAMPLE_REPORT_RED);
    (document.getElementById("f") as HTMLInputElement).focus();
    card.showReport(SAMPLE_REPORT_GREEN);
    expect(document.activeElement?.id).toBe("f");
  });
});
