import { describe, expect, it } from "vitest";
import { clauseBefore, isNegated, matchParagraph, runRules } from "../src/pipeline/rules.js";
import type { RuleCategory } from "../src/pipeline/rules.js";

const hits = (text: string) => matchParagraph({ index: 0, text });
const cats = (text: string) => [...new Set(hits(text).map((h) => h.category))];

describe("rules: positives", () => {
  const cases: [string, RuleCategory, "high" | "medium" | "low"][] = [
    ["Your subscription renews automatically each month until you cancel.", "auto_renewal", "medium"],
    ["Your annual plan will automatically renew every year at the then-current price.", "auto_renewal", "high"],
    ["At the end of your 7-day free trial you will be charged $14.99 per month.", "trial_converts", "high"],
    ["We will charge your card at the end of the trial unless you cancel first.", "trial_converts", "high"],
    ["Cancellations must be made by telephone and require 30 days' notice.", "cancellation_friction", "high"],
    ["To cancel, you must send a written cancellation request by certified mail.", "cancellation_friction", "high"],
    ["If you cancel within the first year, an early termination fee of $50 applies.", "termination_fee", "high"],
    ["You will be charged for the remainder of the term if you cancel your contract early.", "termination_fee", "high"],
    ["All sales are final and no refunds will be given for any reason.", "no_refund", "high"],
    ["Memberships are non-refundable once purchased by the customer.", "no_refund", "high"],
    ["Returns are refunded as store credit only, never to your card.", "no_refund", "medium"],
    ["You may request a refund within 7 days of purchase, after that no exceptions.", "no_refund", "medium"],
    ["A restocking fee of 25% will be deducted from your refund.", "return_cost", "medium"],
    ["You are responsible for the cost of return shipping on all returns.", "return_cost", "medium"],
    ["We may change our prices at any time without notice to you.", "price_change", "high"],
    ["We may change the subscription price; we will email you 30 days before any change.", "price_change", "medium"],
    ["A service fee of $4.95 is added to every order at checkout.", "extra_fees", "medium"],
    ["Any dispute will be resolved by binding individual arbitration in Delaware.", "arbitration", "low"],
    ["We may sell your personal information to carefully chosen partners.", "data_sharing", "medium"],
  ];
  it.each(cases)("%s -> %s (%s)", (text, category, severity) => {
    const h = hits(text).find((x) => x.category === category);
    expect(h, JSON.stringify(hits(text))).toBeDefined();
    expect(h!.severity).toBe(severity);
    expect(h!.quote).toBe(text);
    expect(h!.title.length).toBeLessThanOrEqual(60);
    expect(h!.summary.split(/\s+/).length).toBeLessThanOrEqual(30);
  });
});

describe("rules: negated phrases do not fire", () => {
  const negatives = [
    "We do not charge a restocking fee.",
    "We never charge restocking fees, handling fees or any other deductions on returns.",
    "The price you see is the price you pay; we do not add service, processing or convenience fees.",
    "FairBox does not offer subscriptions, and nothing you buy from us will ever renew or charge you again automatically.",
    "We do not require arbitration, and nothing in these Terms limits your right to join a class action.",
    "There is no cancellation fee and you can leave whenever you like.",
    "There are no early termination fees on any of our plans.",
    "Return shipping is free and we will never ask you to pay for return shipping.",
    "We do not sell your personal information to anyone.",
    "Your refund goes back to your original payment method within 5 business days of your parcel reaching us.",
    "You can cancel online at any time in your account settings without calling anyone.",
    "Restocking fees do not apply to any order.",
    "If you start an arbitration you pay the nonrefundable filing fee and administrative fees set by the arbitrator.",
    "All sales of gift cards are final and nonrefundable.",
    "Returns that do not comply with this policy may not be eligible for a refund.",
    "You can cancel by calling 1-800-555-0100 or chatting with us online.",
    "Your card issuer may charge you foreign transaction fees.",
  ];
  it.each(negatives)("%s", (text) => {
    expect(cats(text)).toEqual([]);
  });

  it("a conditional no-refund clause still fires", () => {
    expect(cats("If you cancel after the first week, no refunds will be given.")).toContain("no_refund");
  });

  it("a conditional 'if you do not cancel' still fires", () => {
    expect(cats("If you do not cancel before the trial ends, you will be charged $9.99 per month automatically.")).toContain(
      "trial_converts",
    );
  });

  it("negation in an earlier clause does not cancel a later one", () => {
    expect(cats("If you are not satisfied with the item, we charge a restocking fee of 15% on the return.")).toContain("return_cost");
  });
});

describe("negation helpers", () => {
  it("clauseBefore keeps short list items together", () => {
    expect(clauseBefore("we do not add service, processing or ")).toContain("not");
    expect(clauseBefore("if you send it back, you will pay a ")).toBe(" you will pay a ");
  });
  it("isNegated looks just before and just after the match", () => {
    const t = "restocking fees do not apply to sale items.";
    expect(isNegated(t, 0, "restocking fees".length)).toBe(true);
    const u = "we charge a restocking fee.";
    expect(isNegated(u, u.indexOf("restocking"), u.indexOf(" fee") + 4)).toBe(false);
  });
});

describe("rules: quotes", () => {
  it("quotes are substrings of the paragraph and at most 300 chars", () => {
    const long =
      "In consideration of the many services provided under this agreement, which include streaming, downloads, profiles, recommendations, parental controls, device management, offline viewing, and early access to selected premieres, and subject always to the other provisions of these terms, your subscription renews automatically each month until you cancel it in accordance with section 9 below, which describes how to cancel and what happens to your account afterwards.";
    const h = runRules([{ index: 3, text: long }]).find((x) => x.category === "auto_renewal");
    expect(h).toBeDefined();
    expect(h!.quote.length).toBeLessThanOrEqual(300);
    expect(long).toContain(h!.quote);
    expect(h!.paragraphIndex).toBe(3);
  });

  it("headings are not quoted", () => {
    expect(hits("Restocking fee")).toEqual([]);
  });

  it("handles curly quotes and dashes", () => {
    expect(cats("Cancellations require 30 days’ notice and must be made by telephone — sorry.")).toContain(
      "cancellation_friction",
    );
  });
});
