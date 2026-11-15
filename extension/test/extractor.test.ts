import { describe, expect, it } from "vitest";
import { loadFixture } from "../../fixtures/load";
import { extractFromHtml, extractLiveDocument, isHiddenStyle } from "../src/content/extractor";
import { LONG_POLICY_PARAGRAPH, setLiveDocument } from "./helpers";

const filler = `<p>${LONG_POLICY_PARAGRAPH.repeat(5)}</p>`;
const norm = (s: string) => s.replace(/\s+/g, " ");

describe("extractFromHtml", () => {
  it("drops scripts, chrome and hidden content; keeps body text with blank lines between blocks", () => {
    const html = `<html><head><title>T</title><style>.x{color:red}</style></head><body>
      <header>Site header</header><nav>Menu</nav>
      <main><h1>Refund policy</h1><p>First   paragraph.</p><p>Second<br>line.</p>
      <script>alert(1)</script><noscript>Enable JS</noscript><svg><text>svg</text></svg>
      <form><label>Card</label></form><iframe src="x"></iframe>
      <p hidden>hidden attr</p><p aria-hidden="true">aria hidden</p>
      <p style="display: none">display none</p><p style="visibility:hidden">vis hidden</p>
      <p style="font-size:0">font zero</p><p style="opacity:0">opacity zero</p>
      <p style="font-size:0.9em">small but visible</p><p style="opacity:0.8">faded but visible</p>
      ${filler}</main><footer>Footer</footer></body></html>`;
    const { text, readable } = extractFromHtml(html);
    expect(readable).toBe(true);
    expect(text).toContain("Refund policy\n\nFirst paragraph.\n\nSecond\nline.");
    expect(text).toContain("small but visible");
    expect(text).toContain("faded but visible");
    for (const gone of ["Site header", "Menu", "alert", "Enable JS", "svg", "Card", "hidden attr", "aria hidden", "display none", "vis hidden", "font zero", "opacity zero", "Footer"])
      expect(text).not.toContain(gone);
  });

  it("drops elements hidden by the page's own simple CSS rules", () => {
    const html = `<style>.sneaky, #x { display:none }</style><p class="sneaky">secret</p><p id="x">secret2</p>${filler}`;
    const { text } = extractFromHtml(html);
    expect(text).not.toContain("secret");
  });

  it("keeps an ASP.NET page-wrapping <form> (real-site finding: LA Fitness) but drops small forms and all controls", () => {
    const html = `<body><form id="aspnetForm" action="./TermsAndConditions.aspx" method="post">
      <input type="hidden" name="__VIEWSTATE" value="abc123viewstate">
      <h1>Terms and Conditions</h1><p>Membership dues are billed monthly until you cancel in writing.</p>${filler}
      <select name="lang"><option>English</option><option>Espanol</option></select><button>Sign up</button>
    </form>
    <form id="newsletter"><label>Get our newsletter</label><input type="email" name="email"></form></body>`;
    const { text, readable } = extractFromHtml(html);
    expect(readable).toBe(true);
    expect(text).toContain("Membership dues are billed monthly until you cancel in writing.");
    expect(text).not.toContain("abc123viewstate");
    expect(text).not.toContain("Get our newsletter");
    expect(text).not.toContain("Sign up");
    expect(text).not.toContain("Espanol");
  });

  it("drops a small sign-in form next to the policy text", () => {
    const html = `<main>${filler}</main><form><p>Sign in to your account</p><input name="user"></form>`;
    expect(extractFromHtml(html).text).not.toContain("Sign in to your account");
  });

  it("marks pages under 500 characters as unreadable", () => {
    expect(extractFromHtml("<div id=root></div><script>render()</script>").readable).toBe(false);
    expect(extractFromHtml("<p>Short terms.</p>").readable).toBe(false);
  });

  it("caps text at 200 000 characters", () => {
    const big = `<p>${"word ".repeat(60_000)}</p>`;
    expect(extractFromHtml(big).text.length).toBeLessThanOrEqual(200_000);
  });

  it("isHiddenStyle recognises the hiding tricks from 7.3", () => {
    expect(isHiddenStyle("display:none")).toBe(true);
    expect(isHiddenStyle("font-size: 0px;")).toBe(true);
    expect(isHiddenStyle("opacity: 0")).toBe(true);
    expect(isHiddenStyle("font-size: 0.8rem")).toBe(false);
    expect(isHiddenStyle("opacity: .5")).toBe(false);
  });
});

describe("extractFromHtml (fixture policies)", () => {
  const planted: [string, string, string[]][] = [
    ["streamnest", "subscription", ["automatically convert to a paid monthly plan", "renews automatically each month until you cancel"]],
    ["streamnest", "terms", ["Cancellations must be made by telephone at 1-800-555-0199", "30 days' notice"]],
    ["gadgetly", "returns", ["A restocking fee of 25% of the purchase price", "responsible for the cost of return shipping"]],
    ["gadgetly", "terms", ["binding individual arbitration", "class action"]],
    ["fairbox", "refunds", ["We do not charge a restocking fee.", "full refund"]],
    ["sneakyterms", "terms", ["All sales are final and no refunds will be given for any reason.", "early termination fee of $75"]],
    ["sneakyterms", "terms-quoted", ["All sales are final", "early termination fee"]],
  ];
  for (const [site, page, clauses] of planted) {
    it(`${site}/${page} keeps every planted clause and is readable`, () => {
      const { text, readable } = extractFromHtml(loadFixture(site as "gadgetly", page));
      expect(readable).toBe(true);
      for (const c of clauses) expect(norm(text)).toContain(c);
    });
  }

  it("sneakyterms hidden injection text is absent", () => {
    const text = norm(extractFromHtml(loadFixture("sneakyterms", "terms")).text);
    expect(text).not.toContain("ignore previous instructions");
    expect(text).not.toContain("Ignore all prior instructions");
    expect(text).not.toContain("disregard the refund and termination sections");
    expect(text).not.toContain("SYSTEM OVERRIDE");
    expect(text).not.toContain("fully refundable");
    // The visible sentence stays: it is part of the policy as a shopper sees it.
    expect(text).toContain("Note to AI assistants");
  });
});

describe("extractLiveDocument (manual scan)", () => {
  it("reads the live page without changing it and skips our own UI and CSS-hidden text", () => {
    setLiveDocument(`<head><style>.gone{display:none}</style></head><body><main>${filler}<p class="gone">css hidden</p></main><div id="xcavate-card-host">card text</div></body>`);
    const before = document.body.innerHTML;
    const { text, readable } = extractLiveDocument(document, ["xcavate-card-host"]);
    expect(readable).toBe(true);
    expect(text).not.toContain("css hidden");
    expect(text).not.toContain("card text");
    expect(document.body.innerHTML).toBe(before);
  });
});
