import { LIMITS } from "@xcavate/shared";
import { describe, expect, it } from "vitest";
import { keywordScore, prefilter } from "@xcavate/shared/engine";
import { MAX_PARAGRAPH_CHARS, splitParagraphs } from "@xcavate/shared/engine";

describe("splitParagraphs", () => {
  it("splits on blank lines, numbers from 0, collapses inner whitespace", () => {
    const p = splitParagraphs("First  para\nstill first.\n\n\n  Second para.  \r\n\r\nThird.");
    expect(p).toEqual([
      { index: 0, text: "First para still first." },
      { index: 1, text: "Second para." },
      { index: 2, text: "Third." },
    ]);
  });

  it("is deterministic and breaks oversized blocks", () => {
    const big = ("A sentence about nothing much at all. ").repeat(200);
    const a = splitParagraphs(big);
    expect(a.length).toBeGreaterThan(1);
    expect(a.every((p) => p.text.length <= MAX_PARAGRAPH_CHARS)).toBe(true);
    expect(splitParagraphs(big)).toEqual(a);
  });

  it("ignores empty input", () => {
    expect(splitParagraphs("  \n\n  ")).toEqual([]);
  });
});

describe("prefilter", () => {
  const paras = splitParagraphs(
    [
      "About us. We love shoes.", // 0 neighbour of 1
      "All sales are final and there are no refunds.", // 1 hit
      "Our office has a nice view.", // 2 neighbour of 1
      "We sponsor a local football team.", // 3 dropped
      "We like dogs.", // 4 dropped
      "Our store opened in 1999.", // 5 neighbour of 6
      "A restocking fee applies to returns.", // 6 hit
    ].join("\n\n"),
  );

  it("keeps hits plus one neighbour either side, in document order", () => {
    const { kept } = prefilter([{ paragraphs: paras }]);
    expect(kept[0].map((p) => p.index)).toEqual([0, 1, 2, 5, 6]);
  });

  it("drops the policy entirely when nothing hits", () => {
    const { kept } = prefilter([{ paragraphs: splitParagraphs("We like dogs.\n\nAnd cats.") }]);
    expect(kept[0]).toEqual([]);
  });

  it("respects the char budget, best-scoring first, and keeps document order", () => {
    const many = splitParagraphs(
      Array.from({ length: 400 }, (_, i) =>
        i % 2 === 0 ? `Paragraph ${i}: refund, restocking fee, return shipping and arbitration apply here.` : `Filler paragraph ${i} about our history.`,
      ).join("\n\n"),
    );
    const { kept, totalChars } = prefilter([{ paragraphs: many }], 2_000);
    expect(totalChars).toBeLessThanOrEqual(2_000);
    const idx = kept[0].map((p) => p.index);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    // Hits outrank neighbours: the budget is spent on hit paragraphs first.
    const hitChars = kept[0].filter((p) => keywordScore(p.text) > 0).reduce((n, p) => n + p.text.length, 0);
    expect(hitChars).toBeGreaterThan(2_000 - 100);
  });

  it("never exceeds the 24 000 char default across policies", () => {
    const one = splitParagraphs(Array.from({ length: 600 }, (_, i) => `Clause ${i}: we may change the price and charge a cancellation fee.`).join("\n\n"));
    const { totalChars } = prefilter([{ paragraphs: one }, { paragraphs: one }]);
    expect(totalChars).toBeLessThanOrEqual(LIMITS.prefilterMaxChars);
  });
});
