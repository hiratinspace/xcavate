import { describe, expect, it, vi } from "vitest";
import { fixtureUrl, loadFixture } from "../../fixtures/load";
import { findPolicies, findPolicyCandidates, findWellKnown } from "../src/content/policyFinder";
import { htmlDoc } from "./helpers";

const PAGE = "https://shop.example/checkout";

describe("findPolicies (inline)", () => {
  it("matches link text first, then href", () => {
    const doc = htmlDoc(`<a href="/p/1">Refund policy</a><a href="/legal/terms-of-sale">Read this</a>`, PAGE);
    expect(findPolicies(doc, PAGE)).toEqual([
      { url: "https://shop.example/p/1", kind: "refund" },
      { url: "https://shop.example/legal/terms-of-sale", kind: "terms" },
    ]);
  });

  it("orders by kind priority, then document order", () => {
    const doc = htmlDoc(
      `<a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/returns">Returns</a><a href="/billing-terms">Billing terms</a>`,
      PAGE,
    );
    expect(findPolicies(doc, PAGE).map((p) => p.kind)).toEqual(["subscription", "refund", "terms", "privacy"]);
  });

  it("puts links in the 'you agree to' sentence first", () => {
    const doc = htmlDoc(
      `<footer><a href="/returns">Returns</a><a href="/subscription">Subscription</a></footer>
       <p>By placing your order you agree to our <a href="/privacy">Privacy Policy</a>.</p>`,
      PAGE,
    );
    expect(findPolicies(doc, PAGE)[0]).toEqual({ url: "https://shop.example/privacy", kind: "privacy" });
  });

  it("de-duplicates by URL without hash, caps 4 total and 2 per kind, http(s) only", () => {
    const doc = htmlDoc(
      `<a href="/terms#a">Terms</a><a href="/terms#b">Terms again</a>
       <a href="/t2">Terms of sale</a><a href="/t3">Conditions</a>
       <a href="/refund">Refunds</a><a href="/privacy">Privacy</a><a href="/privacy-2">Privacy 2</a>
       <a href="mailto:legal@shop.example">Legal</a><a href="javascript:void 0">Terms</a><a href="#terms">Terms</a>`,
      PAGE,
    );
    const got = findPolicies(doc, PAGE);
    expect(got.length).toBe(4);
    expect(got.filter((p) => p.kind === "terms").length).toBe(2);
    expect(new Set(got.map((p) => p.url)).size).toBe(got.length);
    for (const p of got) {
      expect(p.url).toMatch(/^https?:\/\//);
      expect(p.url).not.toContain("#");
    }
  });

  it("does not treat 'Return to cart' as a refund policy, nor 'photos' as tos", () => {
    const doc = htmlDoc(`<a href="/cart">Return to cart</a><a href="/photos">Gallery</a>`, PAGE);
    expect(findPolicies(doc, PAGE)).toEqual([]);
  });

  it("skips empty, '#', '#modal-…', javascript: and same-page links so they don't use up a kind's quota", () => {
    const page = "https://stream.example/welcome?plan=basic";
    const doc = htmlDoc(
      `<a href="">Terms apply</a><a href="#">Terms apply</a><a href="#modal-terms">Terms apply</a>
       <a href="javascript:openTerms()">Terms apply</a><a href="/welcome?plan=basic#legal">Terms apply</a>
       <a href="/legal/subscriber-agreement">Subscriber Agreement</a><a href="/terms-of-use">Terms of Use</a>`,
      page,
    );
    expect(findPolicies(doc, page)).toEqual([
      { url: "https://stream.example/legal/subscriber-agreement", kind: "terms" },
      { url: "https://stream.example/terms-of-use", kind: "terms" },
    ]);
  });

  it("matches subscriber/membership agreements and 'Terms apply' link text", () => {
    const doc = htmlDoc(
      `<a href="/a">Hulu Subscriber Agreement</a><a href="/b">Membership Agreement</a><a href="/c">Terms apply.</a>`,
      PAGE,
    );
    expect(findPolicyCandidates(doc, PAGE).map((c) => c.kind)).toEqual(["terms", "terms", "terms"]);
  });

  it("keeps cross-origin links as absolute URLs", () => {
    const doc = htmlDoc(`<a href="https://legal.example/terms">Terms of Service</a>`, PAGE);
    expect(findPolicies(doc, PAGE)).toEqual([{ url: "https://legal.example/terms", kind: "terms" }]);
  });
});

describe("findWellKnown", () => {
  it("probes same-origin paths and keeps the first two that answer", async () => {
    const probe = vi.fn(async (u: string) => (u.endsWith("/terms") || u.endsWith("/returns") || u.endsWith("/legal/terms") ? "<p>ok</p>" : undefined));
    const got = await findWellKnown("https://shop.example/checkout?x=1", probe);
    expect(got.map((g) => g.link)).toEqual([
      { url: "https://shop.example/terms", kind: "terms" },
      { url: "https://shop.example/returns", kind: "refund" },
    ]);
    expect(probe).not.toHaveBeenCalledWith("https://shop.example/legal/terms");
  });
});

describe("findPolicies (fixture checkouts)", () => {
  const expected: Record<string, { url: string; kind: string }[]> = {
    streamnest: [
      { url: fixtureUrl("streamnest", "subscription"), kind: "subscription" },
      { url: "http://legal.localhost:4001/streamnest/terms", kind: "terms" },
      { url: fixtureUrl("streamnest", "privacy"), kind: "privacy" },
    ],
    gadgetly: [
      { url: fixtureUrl("gadgetly", "returns"), kind: "refund" },
      { url: fixtureUrl("gadgetly", "terms"), kind: "terms" },
      { url: fixtureUrl("gadgetly", "privacy"), kind: "privacy" },
    ],
    fairbox: [
      { url: fixtureUrl("fairbox", "refunds"), kind: "refund" },
      { url: fixtureUrl("fairbox", "terms"), kind: "terms" },
      { url: fixtureUrl("fairbox", "privacy"), kind: "privacy" },
    ],
    sneakyterms: [
      { url: fixtureUrl("sneakyterms", "terms"), kind: "terms" },
      { url: fixtureUrl("sneakyterms", "privacy"), kind: "privacy" },
    ],
  };
  for (const [site, want] of Object.entries(expected)) {
    it(`${site}: kinds and priority order`, () => {
      const url = fixtureUrl(site as "gadgetly", "checkout");
      const doc = htmlDoc(loadFixture(site as "gadgetly", "checkout"), url);
      expect(findPolicies(doc, url)).toEqual(want);
      expect(findPolicyCandidates(doc, url).every((c) => c.agree)).toBe(true);
    });
  }
});
