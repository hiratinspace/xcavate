/** Regression tests for the direction v2 round (V-02, V-05, V-07, V-10, V-11) and the netguard review. */
import { DEFAULT_SETTINGS, SAMPLE_REPORT_GREEN, SAMPLE_REPORT_RED, type Flag, type Report } from "@xcavate/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { badgeFor } from "../src/background/badge";
import { createHandlers } from "../src/background/handlers";
import { Card } from "../src/content/card";
import { classify } from "../src/content/classifier";
import { collectPolicies } from "../src/content/collect";
import { WELL_KNOWN_PATHS, findWellKnown } from "../src/content/policyFinder";
import { andList, cardFlags, chargeHeadline, linkParts, partialNote, RIGHTS_LABEL } from "../src/lib/actions";
import { isFetchAllowed, isInternalHost } from "../src/lib/netguard";
import { PRIVACY_LINE, renderPopup } from "../src/popup/render";
import { installChromeMock } from "./chromeMock";
import { htmlDoc, setLiveDocument } from "./helpers";

const noop = { scan() {}, setEnabled() {}, setPaused() {}, saveApiBase() {}, downloadIcs() {} };
const popup = (report: Report) => {
  document.body.innerHTML = "<main id=app></main>";
  const root = document.getElementById("app")!;
  renderPopup(root, { settings: DEFAULT_SETTINGS, state: { status: "ready", report }, domain: report.domain }, noop);
  return root;
};
const flag = (over: Partial<Flag>): Flag => ({ ...SAMPLE_REPORT_RED.flags[1], ...over });

const PARTIAL: Report = {
  ...SAMPLE_REPORT_GREEN,
  verdict: "partial",
  flags: [],
  policies: [
    { url: "https://shop.example/privacy", kind: "privacy", textHash: "a".repeat(64), status: "analyzed" },
    { url: "https://shop.example/terms", kind: "terms", textHash: "", status: "unreadable" },
  ],
};

describe("1. V-02 partial verdict", () => {
  beforeEach(() => setLiveDocument("<body></body>"));

  it("card: slate state with ◐, names what we couldn't read and points at Scan this page", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(PARTIAL);
    const root = card.shadow;
    expect(root.querySelector(".card")?.getAttribute("data-verdict")).toBe("partial");
    expect(root.querySelector<HTMLElement>(".glyph")?.dataset.icon).toBe("partial");
    expect(root.querySelector(".word")?.textContent).toBe("Partly read");
    expect(root.querySelector(".coverage")?.textContent).toBe("Couldn't read the terms. Open it and press Scan this page.");
    expect(root.textContent).not.toContain("Looks fair");
  });

  it("note when only a privacy policy was found", () => {
    const onlyPrivacy: Report = { ...PARTIAL, policies: [PARTIAL.policies[0]] };
    expect(partialNote(onlyPrivacy)).toBe("We found only the privacy policy. If the site has terms or a refund policy, open it and press Scan this page.");
  });

  it("names two unreadable policies with 'and'", () => {
    const two: Report = { ...PARTIAL, policies: [...PARTIAL.policies, { url: "https://shop.example/returns", kind: "refund", textHash: "", status: "unreadable" }] };
    expect(partialNote(two)).toBe("Couldn't read the terms and refund policy. Open them and press Scan this page.");
    expect(andList(["a", "b", "c"])).toBe("a, b and c");
  });

  it("badge is grey ◐, never green", () => {
    const b = badgeFor(PARTIAL, "ready");
    expect(b.text).toBe("◐");
    expect(b.color).not.toBe(badgeFor(SAMPLE_REPORT_GREEN, "ready").color);
    expect(b.color).toBe(badgeFor(undefined, "checking").color);
  });

  it("popup: partial section with the unreadable policy and the Scan hint", () => {
    const root = popup(PARTIAL);
    expect(root.firstElementChild?.getAttribute("data-verdict")).toBe("partial");
    const sec = root.querySelector("section.partial")!;
    expect(sec.textContent).toContain("Couldn't read the terms");
    expect(sec.textContent).toContain("Scan this page");
    expect(root.textContent).not.toContain("Looks fair");
  });
});

describe("2. Flag context and rights notes", () => {
  beforeEach(() => setLiveDocument("<body></body>"));
  const report: Report = {
    ...SAMPLE_REPORT_RED,
    trial: undefined,
    flags: [
      flag({
        id: "auto_renewal:1",
        context: "Normal for subscriptions. You can cancel online.",
        rightsNote: "Many US states require online cancellation. See https://example.gov/arl. javascript:alert(1) stays text.",
      }),
    ],
  };

  it("card: context line and labelled rights box on a top-3 flag", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(report);
    const root = card.shadow;
    expect(root.querySelector(".flag-ctx")?.textContent).toBe("Normal for subscriptions. You can cancel online.");
    expect(root.querySelector(".rights-label")?.textContent).toBe(RIGHTS_LABEL);
    const links = Array.from(root.querySelectorAll(".rights a")) as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.gov/arl"]);
  });

  it("popup: context and rights note, no link without an http(s) URL", () => {
    const root = popup({ ...report, flags: [flag({ rightsNote: "Your state may let you cancel online.", context: "Common." })] });
    expect(root.querySelector(".ctx")?.textContent).toBe("Common.");
    expect(root.querySelector(".rights")?.textContent).toBe(RIGHTS_LABEL + "Your state may let you cancel online.");
    expect(root.querySelector(".rights a")).toBeNull();
  });

  it("linkParts only links http(s) URLs and leaves trailing punctuation out", () => {
    expect(linkParts("See https://a.gov/x. Or ftp://b, javascript:alert(1)")).toEqual([
      { text: "See " },
      { text: "https://a.gov/x", href: "https://a.gov/x" },
      { text: ". Or ftp://b, javascript:alert(1)" },
    ]);
  });
});

describe("3. V-05 charge-date headline and reminder on the card", () => {
  beforeEach(() => setLiveDocument("<body></body>"));

  it("chargeHeadline: date is today + lengthDays, period suffix, no price → paid", () => {
    const today = new Date(2026, 10, 14);
    expect(chargeHeadline({ lengthDays: 7, priceAfter: "$14.99", billingPeriod: "month" }, today, "en-US")).toBe(
      "Free for 7 days, then $14.99/month from Sat, Nov 21",
    );
    expect(chargeHeadline({ lengthDays: 1, priceAfter: "$5", billingPeriod: "week" }, today, "en-US")).toBe("Free for 1 day, then $5/week from Sun, Nov 15");
    expect(chargeHeadline({ lengthDays: 30 }, today, "en-US")).toBe("Free for 30 days, then paid from Mon, Dec 14");
    expect(chargeHeadline({ lengthDays: 7, priceAfter: "$14.99 per month", billingPeriod: "month" }, today, "en-US")).toBe(
      "Free for 7 days, then $14.99 per month from Sat, Nov 21",
    );
    expect(chargeHeadline({ priceAfter: "$9" }, today)).toBeUndefined();
  });

  it("card: headline is announced, reminder actions are real links, one quote with See in policy", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(SAMPLE_REPORT_RED);
    const root = card.shadow;
    const h = root.querySelector('[role="status"]')!;
    expect(h.textContent).toMatch(/^Free for 7 days, then \$14\.99\/month from \w{3}, \w{3} \d{1,2}$/);
    const cal = root.querySelector(".remind a.primary") as HTMLAnchorElement;
    expect(cal.textContent).toBe("Remind me 2 days before");
    expect(cal.href).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
    const ics = root.querySelector('.remind a[download]') as HTMLAnchorElement;
    expect(ics.getAttribute("href")).toMatch(/^data:text\/calendar;charset=utf-8,BEGIN%3AVCALENDAR/);
    const quotes = root.querySelectorAll("blockquote");
    expect(quotes).toHaveLength(1);
    expect(quotes[0].textContent).toContain("automatically convert to a paid monthly plan");
    expect((quotes[0].querySelector("a") as HTMLAnchorElement).getAttribute("href")).toContain("#:~:text=");
    // The trial flag is the quote, so it is not repeated; the other money flags follow; arbitration never.
    const titles = Array.from(root.querySelectorAll(".flag-title")).map((t) => t.firstChild?.textContent);
    expect(titles).not.toContain(SAMPLE_REPORT_RED.flags[0].title);
    expect(titles).toHaveLength(2);
    expect(root.textContent).not.toMatch(/arbitration/i);
  });
});

describe("4. Card top 3 skips arbitration and data sharing", () => {
  it("cardFlags filters and puts money first, stable otherwise", () => {
    const fs = [
      { category: "arbitration", n: 0 },
      { category: "missing_policy", n: 1 },
      { category: "data_sharing", n: 2 },
      { category: "auto_renewal", n: 3 },
      { category: "hidden_fees", n: 4 },
      { category: "refund_limits", n: 5 },
    ];
    expect(cardFlags(fs).map((f) => f.n)).toEqual([3, 4, 5]);
    expect(cardFlags(fs.slice(0, 4)).map((f) => f.n)).toEqual([3, 1]);
  });

  it("the popup still lists arbitration", () => {
    const root = popup(SAMPLE_REPORT_RED);
    expect(root.querySelectorAll(".flags .flag")).toHaveLength(SAMPLE_REPORT_RED.flags.length);
    expect(root.textContent).toMatch(/arbitration/i);
  });
});

describe("5. V-07 plans and pricing pages qualify as sign-up", () => {
  it.each([
    ["button CTA + /mo", `<h1>Pricing</h1><div><h2>Pro</h2><p>$9.99/mo</p><button>Start free trial</button></div>`, "https://app.example/pricing"],
    ["link CTA + per month", `<h2>Basic</h2><p>$12 per month, billed monthly</p><a href="/signup?plan=basic">Try it free</a>`, "https://tool.example/"],
    ["N-day trial + get started", `<p>14-day trial, no card needed.</p><a class="btn" href="/start">Get started free</a>`, "https://saas.example/features"],
    ["/year + start your trial", `<p>€99/year</p><a href="/join">Start your trial</a>`, "https://eu.example/offer"],
  ])("%s", (_name, body, url) => {
    expect(classify(htmlDoc(body, url), url).pageType).toBe("signup");
  });

  it.each([
    ["CTA without a price", `<p>Our app helps teams.</p><a href="/x">Try it free</a>`, "https://app.example/"],
    ["price without a CTA", `<p>Plans from $9.99/mo</p><a href="/pricing">See plans</a>`, "https://app.example/"],
    [
      "news story with a paywall banner",
      `<article><h1>Council votes</h1>${"<p>The council met on Tuesday and discussed the budget at length. </p>".repeat(30)}</article><aside>$1/week for 6 months. <a href="/subscribe">Start free trial</a></aside>`,
      "https://news.example/2026/11/council-votes",
    ],
  ])("stays none: %s", (_name, body, url) => {
    expect(classify(htmlDoc(body, url), url).pageType).toBe("none");
  });
});

describe("6. V-10 Shopify policy paths come first", () => {
  it("lists the /policies/ paths before the generic ones and probes them in order", async () => {
    expect(WELL_KNOWN_PATHS.slice(0, 3).map((p) => p.path)).toEqual([
      "/policies/refund-policy",
      "/policies/terms-of-service",
      "/policies/subscription-policy",
    ]);
    const probed: string[] = [];
    const found = await findWellKnown("https://store.example/checkouts/abc", async (u) => {
      probed.push(u);
      return u.includes("/policies/") ? "<p>policy</p>" : undefined;
    });
    expect(probed.slice(0, 2)).toEqual(["https://store.example/policies/refund-policy", "https://store.example/policies/terms-of-service"]);
    expect(found.map((f) => [f.link.url, f.link.kind])).toEqual([
      ["https://store.example/policies/refund-policy", "refund"],
      ["https://store.example/policies/terms-of-service", "terms"],
    ]);
  });
});

describe("7. V-11 the backend gets origin + '/' only", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("collectPolicies sends origin + '/' as pageUrl", async () => {
    const doc = htmlDoc(`<a href="/terms">Terms</a>`, "https://shop.example/checkout/step-2");
    const req = await collectPolicies(doc, "https://shop.example/checkout/step-2?cart=SECRET", "checkout", {
      fetchHtml: async () => `<p>${"Terms text here. ".repeat(60)}</p>`,
    });
    expect(req.pageUrl).toBe("https://shop.example/");
    expect(JSON.stringify(req)).not.toContain("/checkout");
  });

  it("the service worker uses the local page field for the late-reply check and never forwards it", async () => {
    const mock = installChromeMock();
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (u: string, init?: RequestInit) => {
      if (String(u).includes("/v1/report")) return new Response("", { status: 404 });
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ ...SAMPLE_REPORT_RED, domain: "a.com" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await h.pageReady({ type: "PAGE_READY", pageType: "checkout", score: 9, url: "https://a.com/checkout" }, 4);
    const request = { pageUrl: "https://a.com/", pageType: "checkout" as const, linksFound: 1, policies: [{ url: "https://a.com/terms", kind: "terms" as const, text: "x".repeat(600) }] };
    expect((await h.handle({ type: "ANALYZE", request, page: "https://a.com/checkout" }, { tab: { id: 4 } } as chrome.runtime.MessageSender))).toMatchObject({ ok: true });
    expect(mock.session.data()["tab:4"]).toMatchObject({ status: "ready", pageUrl: "https://a.com/checkout" });
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]).pageUrl).toBe("https://a.com/");
    expect(bodies[0]).not.toContain("/checkout");
    expect(bodies[0]).not.toContain("\"page\"");
  });

  it("popup privacy line says the backend gets the domain only", () => {
    expect(PRIVACY_LINE).toContain("the site's address (domain only)");
    const root = popup(SAMPLE_REPORT_GREEN);
    expect(root.querySelector("footer")?.textContent).toContain(PRIVACY_LINE);
  });
});

describe("netguard: IPs hidden in names and unusual IP spellings", () => {
  it.each([
    "192.168.1.1.nip.io",
    "app.10.0.0.1.nip.io",
    "192-168-1-1.sslip.io",
    "c0a80101.nip.io",
    "anything.xip.io",
    "lvh.me",
    "shop.localtest.me",
    "10.0.0.5.example.com",
    "printer-192-168-0-10.example.net",
    "api.127.0.0.1.custom-dns.test",
    "3232235777",
    "0xC0A80101",
    "0300.0250.1.1",
    "127.1",
    "[::127.0.0.1]",
    "[::7f00:1]",
    "[64:ff9b::192.168.1.1]",
    "[64:ff9b::a00:1]",
    "[64:ff9b:1::5]",
    "[2002:c0a8:101::1]",
    "[0:0:0:0:0:ffff:7f00:1]",
    "[ff02::1]",
    "[fec0::1]",
  ])("blocks %s", (host) => {
    expect(isInternalHost(host)).toBe(true);
    expect(isFetchAllowed(`http://${host}/terms`, "https://shop.example/checkout")).toBe(false);
  });

  it.each([
    "http://3232235777/",
    "http://0xC0A80101/",
    "http://0300.0250.1.1/",
    "http://[::127.0.0.1]/",
    "http://[64:ff9b::192.168.1.1]/",
    "http://192-168-1-1.sslip.io/",
  ])("isFetchAllowed refuses %s (URL-normalised form)", (url) => {
    expect(isFetchAllowed(url, "https://shop.example/checkout")).toBe(false);
  });

  it.each(["shop.example", "8.8.8.8", "[2606:4700::1111]", "[64:ff9b::808:808]", "[::ffff:808:808]", "deal-2024-11-14-sale.example", "1.2.3.4.example.com", "store.myshopify.com"])(
    "allows public %s",
    (host) => {
      expect(isInternalHost(host)).toBe(false);
    },
  );

  it("an internal page may still reach internal hosts (fixture stores)", () => {
    expect(isFetchAllowed("http://192.168.1.1.nip.io/terms", "http://streamnest.localhost:4000/checkout")).toBe(true);
  });
});
