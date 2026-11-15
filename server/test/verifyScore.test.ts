import type { Flag, PolicyKind } from "@xcavate/shared";
import { describe, expect, it } from "vitest";
import { MISSING_POLICY_FLAG, applyCaps, capSeverity, computeVerdict, needsMissingPolicy, sortFlags } from "@xcavate/shared/engine";
import { splitParagraphs } from "@xcavate/shared/engine";
import { locateQuote, prepareForVerify, verifyQuote } from "@xcavate/shared/engine";

const POLICY_A = "Refunds.\n\nAll sales are final. We don’t give   refunds\nfor “sale” items — sorry.";
const POLICY_B = "Shipping.\n\nWe ship worldwide within 3 days.";

describe("verifyQuote", () => {
  it("exact quote passes", () => {
    expect(verifyQuote("All sales are final.", POLICY_A)).toBe(true);
  });
  it("different spacing, curly quotes and dashes pass", () => {
    expect(verifyQuote(`We don't give refunds for "sale" items - sorry.`, POLICY_A)).toBe(true);
    expect(verifyQuote("ALL   SALES\nARE FINAL", POLICY_A)).toBe(true);
  });
  it("invented quote fails", () => {
    expect(verifyQuote("All sales are final and you owe us $500.", POLICY_A)).toBe(false);
  });
  it("quote from a different policy fails", () => {
    expect(verifyQuote("We ship worldwide within 3 days.", POLICY_A)).toBe(false);
    expect(verifyQuote("We ship worldwide within 3 days.", POLICY_B)).toBe(true);
  });
  it("tiny or empty quotes fail", () => {
    expect(verifyQuote("", POLICY_A)).toBe(false);
    expect(verifyQuote("a", POLICY_A)).toBe(false);
  });
});

describe("locateQuote", () => {
  const pols = [POLICY_A, POLICY_B].map((t) => prepareForVerify(t, splitParagraphs(t)));
  it("finds the right paragraph, even when the model named the wrong policy", () => {
    expect(locateQuote("All sales are final.", pols, 0)).toEqual({ policy: 0, paragraphIndex: 1 });
    expect(locateQuote("We ship worldwide within 3 days.", pols, 0)).toEqual({ policy: 1, paragraphIndex: 1 });
    expect(locateQuote("Made up sentence here.", pols, 0)).toBeNull();
  });
});

const flag = (category: Flag["category"], severity: Flag["severity"]): Flag => ({
  id: category + ":00000000",
  category,
  severity,
  title: "t",
  summary: "s",
  quote: "q",
  policyUrl: "u",
  paragraphIndex: 0,
  source: "rules",
});

describe("score", () => {
  it("caps severities per category and never raises them", () => {
    expect(capSeverity("arbitration", "high")).toBe("medium");
    expect(capSeverity("return_cost", "high")).toBe("medium");
    expect(capSeverity("no_refund", "high")).toBe("high");
    expect(capSeverity("termination_fee", "low")).toBe("low");
    expect(applyCaps([flag("extra_fees", "high")])[0].severity).toBe("medium");
  });

  it("sorts by severity desc, then category order", () => {
    const sorted = sortFlags([flag("arbitration", "low"), flag("no_refund", "high"), flag("return_cost", "medium"), flag("auto_renewal", "high")]);
    expect(sorted.map((f) => f.category)).toEqual(["auto_renewal", "no_refund", "return_cost", "arbitration"]);
  });

  const table: [string, Flag[], PolicyKind[], string][] = [
    ["any high -> red", [flag("no_refund", "high"), flag("arbitration", "low")], ["terms"], "red"],
    ["a medium -> yellow", [flag("return_cost", "medium")], ["refund"], "yellow"],
    ["two money lows -> yellow", [flag("auto_renewal", "low"), flag("extra_fees", "low")], ["terms"], "yellow"],
    ["two non-money lows do not count -> green", [flag("arbitration", "low"), flag("data_sharing", "low")], ["terms"], "green"],
    ["arbitration/data_sharing never count, even medium", [flag("arbitration", "medium"), flag("data_sharing", "medium")], ["terms"], "green"],
    ["one money low -> green", [flag("auto_renewal", "low")], ["subscription"], "green"],
    ["nothing, terms analysed -> green", [], ["terms", "privacy"], "green"],
    ["nothing, refund analysed -> green", [], ["refund"], "green"],
    ["nothing, manual scan analysed -> green", [], ["other"], "green"],
    ["only privacy read -> partial", [], ["privacy"], "partial"],
    ["only privacy read, non-money flag -> partial", [flag("data_sharing", "medium")], ["privacy"], "partial"],
    ["only privacy read, money medium -> yellow", [flag("extra_fees", "medium")], ["privacy"], "yellow"],
    ["nothing readable -> unknown", [], [], "unknown"],
    ["missing_policy alone -> yellow", [MISSING_POLICY_FLAG], [], "yellow"],
  ];
  it.each(table)("%s", (_n, flags, analyzed, verdict) => {
    expect(computeVerdict(flags, analyzed)).toBe(verdict);
  });

  it("missing_policy only for checkout/signup pages with no links and nothing analysed", () => {
    expect(needsMissingPolicy({ pageType: "checkout", linksFound: 0 }, 0)).toBe(true);
    expect(needsMissingPolicy({ pageType: "signup", linksFound: 0 }, 0)).toBe(true);
    expect(needsMissingPolicy({ pageType: "none", linksFound: 0 }, 0)).toBe(false);
    expect(needsMissingPolicy({ pageType: "checkout", linksFound: 2 }, 0)).toBe(false);
    expect(needsMissingPolicy({ pageType: "checkout", linksFound: 0 }, 1)).toBe(false);
  });
});
