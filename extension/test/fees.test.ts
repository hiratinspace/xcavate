import { describe, expect, it } from "vitest";
import { loadFixture } from "../../fixtures/load";
import { classifyFeeLabel, describeExtras, detectFees } from "../src/content/fees";
import { formatMoney, parseAmount, parseNumber } from "../src/lib/money";
import { htmlDoc } from "./helpers";

describe("currency parsing", () => {
  it("parses US and European formats", () => {
    expect(parseAmount("$1,299.00")).toMatchObject({ amount: 1299, currency: "USD" });
    expect(parseAmount("€12,50")).toMatchObject({ amount: 12.5, currency: "EUR" });
    expect(parseAmount("1.299,00 €")).toMatchObject({ amount: 1299, currency: "EUR" });
    expect(parseAmount("£4")).toMatchObject({ amount: 4, currency: "GBP" });
    expect(parseAmount("USD 12.00")).toMatchObject({ amount: 12, currency: "USD" });
    expect(parseAmount("-$5.00")).toMatchObject({ amount: -5 });
    expect(parseAmount("Add plan (+$12.99)")).toMatchObject({ amount: 12.99 });
    expect(parseAmount("no money here")).toBeUndefined();
  });
  it("parseNumber handles thousands separators", () => {
    expect(parseNumber("1,299")).toBe(1299);
    expect(parseNumber("1.299")).toBe(1299);
    expect(parseNumber("12,5")).toBe(12.5);
  });
  it("formats for display", () => {
    expect(formatMoney(4.95, "USD")).toBe("$4.95");
  });
});

describe("classifyFeeLabel", () => {
  it.each([
    ["Subtotal", "subtotal"],
    ["Items (2)", "subtotal"],
    ["Shipping", "shipping"],
    ["Estimated tax", "tax"],
    ["VAT", "tax"],
    ["Promo code SAVE10", "discount"],
    ["Total", "total"],
    ["Order total", "total"],
    ["Amount due", "total"],
    ["Service fee", "extra_fee"],
    ["Protection plan", "extra_fee"],
    ["Convenience charge", "extra_fee"],
    ["Pulse earbuds", undefined],
  ])("%s → %s", (label, kind) => {
    expect(classifyFeeLabel(label)).toBe(kind);
  });
});

describe("detectFees (inline)", () => {
  it("finds extra fees in a European summary", () => {
    const doc = htmlDoc(`<dl><dt>Zwischensumme Subtotal</dt><dd>€1.299,00</dd><dt>Handling fee</dt><dd>€12,50</dd><dt>Total</dt><dd>€1.311,50</dd></dl>`);
    const fees = detectFees(doc)!;
    expect(fees.currency).toBe("EUR");
    expect(fees.extrasTotal).toBe(12.5);
    expect(fees.lines.find((l) => l.kind === "subtotal")?.amount).toBe(1299);
  });

  it("returns nothing when there is no total row (no guessing)", () => {
    const doc = htmlDoc(`<div><span>Service fee</span> <span>$1,299.00</span></div><div><span>Subtotal</span><span>$5.00</span></div>`);
    expect(detectFees(doc)).toBeUndefined();
  });
});

describe("detectFees (fixtures)", () => {
  it("gadgetly: service fee and protection plan, counted once", () => {
    const fees = detectFees(htmlDoc(loadFixture("gadgetly", "checkout")))!;
    expect(fees).toBeDefined();
    const extras = fees.lines.filter((l) => l.kind === "extra_fee");
    expect(extras).toEqual([
      { label: "Service fee", amount: 4.95, kind: "extra_fee" },
      { label: "Protection plan", amount: 12.99, kind: "extra_fee" },
    ]);
    expect(fees.extrasTotal).toBe(17.94);
    expect(describeExtras(fees)).toBe("Service fee $4.95, Protection plan $12.99");
  });

  it("fairbox: no extra fees", () => {
    const fees = detectFees(htmlDoc(loadFixture("fairbox", "checkout")));
    expect(fees?.lines.filter((l) => l.kind === "extra_fee") ?? []).toEqual([]);
    expect(fees?.extrasTotal ?? 0).toBe(0);
  });

  it("streamnest and sneakyterms: no extra fees", () => {
    for (const site of ["streamnest", "sneakyterms"] as const) {
      expect(detectFees(htmlDoc(loadFixture(site, "checkout")))?.extrasTotal ?? 0).toBe(0);
    }
  });
});
