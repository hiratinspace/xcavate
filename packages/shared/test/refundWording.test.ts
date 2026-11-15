import { describe, expect, it } from "vitest";
import { runRules } from "../src/engine/rules.js";
import { splitParagraphs } from "../src/engine/split.js";

const noRefund = (sentence: string) =>
  runRules(splitParagraphs("Refunds and returns.\n\n" + sentence)).filter((h) => h.category === "no_refund");

// Real-site test: "Apple will refund the purchase price" was shown as a high "No refunds" warning.
describe("no_refund wording: a promise to refund is never a no-refund clause", () => {
  it.each([
    "If the item is defective, Apple will refund the purchase price to your original payment method.",
    "We do refund the full price of any item returned within 30 days of delivery.",
    "The seller shall refund your payment to the card you used for the order.",
  ])("%s", (s) => {
    expect(noRefund(s)).toEqual([]);
  });
});

describe("no_refund wording: negated refund verbs are caught", () => {
  it.each([
    "We will not refund any purchase once the order has shipped to you.",
    "The company does not refund fees paid for any subscription or service.",
  ])("%s", (s) => {
    expect(noRefund(s).length).toBeGreaterThan(0);
  });
});
