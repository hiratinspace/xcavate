import { describe, expect, it } from "vitest";
import {
  AnalyzeRequestSchema, ReportSchema, SAMPLE_REPORT_GREEN, SAMPLE_REPORT_RED, CATEGORY_ORDER, SEVERITY_CAPS,
  normalizeForMatch, textFragmentUrl, stripPageUrl, domainOf, flagId, verdictHeadline,
} from "../src/index.js";

describe("schemas", () => {
  it("sample reports pass the Report schema", () => {
    expect(ReportSchema.safeParse(SAMPLE_REPORT_RED).success).toBe(true);
    expect(ReportSchema.safeParse(SAMPLE_REPORT_GREEN).success).toBe(true);
  });
  it("rejects pageUrl with a query string and more than 4 policies", () => {
    const p = { url: "https://a.com/terms", kind: "terms", text: "x" };
    expect(AnalyzeRequestSchema.safeParse({ pageUrl: "https://a.com/c?x=1", pageType: "checkout", linksFound: 1, policies: [] }).success).toBe(false);
    expect(AnalyzeRequestSchema.safeParse({ pageUrl: "https://a.com/c", pageType: "checkout", linksFound: 1, policies: [p, p, p, p, p] }).success).toBe(false);
    expect(AnalyzeRequestSchema.safeParse({ pageUrl: "https://a.com/c", pageType: "checkout", linksFound: 1, policies: [p] }).success).toBe(true);
  });
  it("rejects unknown fields (only contract fields may leave the browser)", () => {
    expect(AnalyzeRequestSchema.safeParse({ pageUrl: "https://a.com/c", pageType: "none", linksFound: 0, policies: [], cart: [1] }).success).toBe(false);
  });
  it("every category has a cap", () => {
    for (const c of CATEGORY_ORDER) expect(SEVERITY_CAPS[c]).toBeDefined();
  });
});

describe("text helpers", () => {
  it("normalises curly quotes, dashes and spacing", () => {
    expect(normalizeForMatch("  You’re   charged — “monthly” ")).toBe("you're charged - \"monthly\"");
  });
  it("builds text fragment URLs", () => {
    expect(textFragmentUrl("https://a.com/t#top", "All sales are final.")).toBe("https://a.com/t#:~:text=All%20sales%20are%20final.");
    const long = "At the end of your 7-day free trial you will be charged every month";
    expect(textFragmentUrl("https://a.com/t", long)).toBe("https://a.com/t#:~:text=At%20the%20end%20of%20your%207%2Dday,be%20charged%20every%20month");
  });
  it("strips query strings and computes domains", () => {
    expect(stripPageUrl("https://www.shop.com/checkout?card=1#x")).toBe("https://www.shop.com/checkout");
    expect(domainOf("https://www.shop.com/x")).toBe("shop.com");
    expect(domainOf("http://streamnest.localhost:4000/x")).toBe("streamnest.localhost:4000");
  });
  it("flag ids are stable and spacing-insensitive", async () => {
    const a = await flagId("no_refund", "All sales  are final");
    expect(a).toMatch(/^no_refund:[0-9a-f]{8}$/);
    expect(await flagId("no_refund", "all sales are final")).toBe(a);
  });
  it("headline wording", () => {
    expect(verdictHeadline(SAMPLE_REPORT_RED)).toBe("3 things to read before you pay");
    expect(verdictHeadline(SAMPLE_REPORT_GREEN)).toBe("No money traps found in the terms");
  });
});
