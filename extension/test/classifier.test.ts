import { describe, expect, it } from "vitest";
import { ARTICLES, fixtureUrl, loadFixture } from "../../fixtures/load";
import { classify } from "../src/content/classifier";
import { htmlDoc } from "./helpers";

describe("classify (inline HTML)", () => {
  it("scores a checkout with card fields and a pay button as checkout", () => {
    const doc = htmlDoc(`<form><input autocomplete="cc-number"><button>Place order</button></form>
      <table><tr><td>Total</td><td>$20.00</td></tr></table>`);
    const r = classify(doc, "https://shop.example/checkout");
    expect(r.pageType).toBe("checkout");
    expect(r.score).toBe(3 + 4 + 3 + 1);
    expect(r.signals).toEqual(expect.arrayContaining(["path:checkout", "card-field", "pay-button", "total-amount"]));
  });

  it("detects card fields by name/id and payment iframes", () => {
    expect(classify(htmlDoc(`<input name="card_number">`), "https://x.example/").signals).toContain("card-field");
    expect(classify(htmlDoc(`<iframe src="https://js.stripe.com/v3/elements"></iframe>`), "https://x.example/").signals).toContain("payment-iframe");
  });

  it("is signup when only signup signals fire", () => {
    const doc = htmlDoc(`<form><input type="email" name="email"><button>Start your free trial</button></form>`);
    const r = classify(doc, "https://stream.example/signup");
    expect(r.pageType).toBe("signup");
    expect(r.score).toBe(5);
  });

  it("reads the caption of a submit input from its attribute, not from typed values", () => {
    const doc = htmlDoc(`<input type="submit" value="Pay now"><input name="cardnumber">`);
    expect(classify(doc, "https://x.example/").signals).toContain("pay-button");
  });

  it("ignores hidden/checkbox inputs for card-name matching", () => {
    const doc = htmlDoc(`<input type="hidden" name="card_token"><input type="checkbox" name="save_card">`);
    expect(classify(doc, "https://x.example/").signals).not.toContain("card-field");
  });

  it("does not qualify a plain blog page", () => {
    const doc = htmlDoc(`<article><h1>Hello</h1><p>Some text about orders.</p><button>Subscribe</button></article>`);
    expect(classify(doc, "https://blog.example/post/1").pageType).toBe("none");
  });

  it("never throws on a bad URL", () => {
    expect(() => classify(htmlDoc("<p>x</p>"), "not a url")).not.toThrow();
  });
});

describe("classify (fixtures)", () => {
  const stores = ["streamnest", "gadgetly", "fairbox", "sneakyterms"] as const;
  for (const site of stores) {
    it(`${site} checkout qualifies`, () => {
      const url = fixtureUrl(site, "checkout");
      const r = classify(htmlDoc(loadFixture(site, "checkout"), url), url);
      expect(r.score).toBeGreaterThanOrEqual(5);
      expect(r.pageType).not.toBe("none");
    });
    it(`${site} product page is none`, () => {
      const url = fixtureUrl(site, "index");
      expect(classify(htmlDoc(loadFixture(site, "index"), url), url).pageType).toBe("none");
    });
  }
  it("shopapp product view is none", () => {
    const url = fixtureUrl("shopapp", "index");
    expect(classify(htmlDoc(loadFixture("shopapp", "index"), url), url).pageType).toBe("none");
  });
  for (const a of ARTICLES) {
    it(`${a} is none`, () => {
      const url = fixtureUrl("pages", a);
      expect(classify(htmlDoc(loadFixture("pages", a), url), url).pageType).toBe("none");
    });
  }
});
