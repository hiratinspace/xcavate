import { ReportSchema } from "@xcavate/shared";
import { describe, expect, it } from "vitest";
import { MockLlm } from "../src/llm/mock.js";
import { runAnalysis } from "../src/pipeline/run.js";
import { FakeLlm, failingLlm, memStore, policyText, request } from "./helpers.js";

const NO_REFUND = "All sales are final and no refunds will be given for any reason.";
const RESTOCK = "A restocking fee of 25% of the purchase price will be deducted from the refund.";

describe("runAnalysis", () => {
  it("returns a schema-valid report with rules flags in mock mode", async () => {
    const r = await runAnalysis(request(policyText(NO_REFUND, RESTOCK)), { store: memStore(), llm: new MockLlm() });
    expect(ReportSchema.safeParse(r).success).toBe(true);
    expect(r.verdict).toBe("red");
    expect(r.domain).toBe("shop.example.com");
    expect(r.flags.map((f) => f.category)).toEqual(["no_refund", "return_cost"]);
    expect(r.flags[0].source).toBe("both");
    expect(r.flags[0].id).toMatch(/^no_refund:[0-9a-f]{8}$/);
  });

  it("falls back to rules only when the LLM fails, with usedLlm:false", async () => {
    const r = await runAnalysis(request(policyText(NO_REFUND)), { store: memStore(), llm: failingLlm() });
    expect(r.stats.usedLlm).toBe(false);
    expect(r.verdict).toBe("red");
    expect(r.flags[0]).toMatchObject({ category: "no_refund", source: "rules" });
  });

  it("does not cache a rules-only result after an LLM failure", async () => {
    const store = memStore();
    await runAnalysis(request(policyText(NO_REFUND)), { store, llm: failingLlm() });
    const again = await runAnalysis(request(policyText(NO_REFUND)), { store, llm: new MockLlm() });
    expect(again.cached).toBe(false);
    expect(again.stats.usedLlm).toBe(true);
  });

  it("drops invented quotes and counts them", async () => {
    const llm = new FakeLlm((input) => ({
      findings: [
        { category: "termination_fee", severity: "high", title: "Exit fee", summary: "You pay to leave.", costImpact: null, paragraphIndex: input[0].paragraphs[0].id, quote: "You owe $500 if you leave early." },
        { category: "no_refund", severity: "high", title: "No refunds at all", summary: "No money back.", costImpact: null, paragraphIndex: 999, quote: NO_REFUND },
      ],
      trial: null,
      cancellation: null,
    }));
    const r = await runAnalysis(request(policyText(NO_REFUND)), { store: memStore(), llm });
    expect(r.stats.droppedUnverified).toBe(1);
    expect(r.flags.map((f) => f.category)).toEqual(["no_refund"]);
    // Wrong paragraph number, real quote: kept and re-located; overlaps the rules flag.
    expect(r.flags[0]).toMatchObject({ source: "both", title: "No refunds at all", paragraphIndex: 1 });
  });

  it("keeps a high rules flag when the LLM reports nothing, and an LLM-only finding when verified", async () => {
    const llm = new FakeLlm((input) => ({
      findings: [
        { category: "price_change", severity: "high", title: "Prices may rise", summary: "They can raise prices.", costImpact: null, paragraphIndex: input[0].paragraphs.at(-1)!.id, quote: "Membership pricing is reviewed each spring" },
      ],
      trial: null,
      cancellation: null,
    }));
    const r = await runAnalysis(request(policyText(NO_REFUND, "Membership pricing is reviewed each spring and refunds follow the rules above.")), {
      store: memStore(),
      llm,
    });
    const byCat = Object.fromEntries(r.flags.map((f) => [f.category, f]));
    expect(byCat.no_refund.source).toBe("rules");
    expect(byCat.price_change.source).toBe("llm");
  });

  it("caps model severities in code", async () => {
    const llm = new FakeLlm((input) => ({
      findings: [{ category: "arbitration", severity: "high", title: "Arbitration", summary: "No court.", costImpact: null, paragraphIndex: input[0].paragraphs[1].id, quote: "Disputes are settled privately by a neutral person chosen by us" }],
      trial: null,
      cancellation: null,
    }));
    const r = await runAnalysis(request(policyText("Disputes are settled privately by a neutral person chosen by us, and refunds are handled per section 2.")), {
      store: memStore(),
      llm,
    });
    expect(r.flags[0]).toMatchObject({ category: "arbitration", severity: "medium" });
    expect(r.verdict).toBe("yellow");
  });

  it("skips the LLM when no paragraph passes the prefilter", async () => {
    const llm = new FakeLlm();
    const r = await runAnalysis(request(policyText("We love dogs and cats.")), { store: memStore(), llm });
    expect(llm.calls).toBe(0);
    expect(r.verdict).toBe("green");
    expect(r.stats.usedLlm).toBe(false);
  });

  it("missing_policy when a checkout page has no policy links", async () => {
    const r = await runAnalysis(request("", { policies: [], linksFound: 0 }), { store: memStore(), llm: new MockLlm() });
    expect(r.flags.map((f) => f.category)).toEqual(["missing_policy"]);
    expect(r.flags[0]).toMatchObject({ quote: "", policyUrl: "", paragraphIndex: -1 });
    expect(r.verdict).toBe("yellow");
  });

  it("unknown when policy links were found but none could be read", async () => {
    const r = await runAnalysis(request("Loading...", { linksFound: 2 }), { store: memStore(), llm: new MockLlm() });
    expect(r.verdict).toBe("unknown");
    expect(r.policies[0].status).toBe("unreadable");
  });

  it("cache hit: cached:true, no LLM call, URLs remapped by hash", async () => {
    const store = memStore();
    const llm = new FakeLlm();
    const text = policyText(NO_REFUND);
    await runAnalysis(request(text), { store, llm });
    expect(llm.calls).toBe(1);
    const t0 = performance.now();
    const r = await runAnalysis(
      request(text, { pageUrl: "https://other.example.com/pay", policies: [{ url: "https://other.example.com/legal", kind: "terms", text }] }),
      { store, llm },
    );
    expect(performance.now() - t0).toBeLessThan(300);
    expect(r.cached).toBe(true);
    expect(llm.calls).toBe(1);
    expect(r.domain).toBe("other.example.com");
    expect(r.flags[0].policyUrl).toBe("https://other.example.com/legal");
  });

  it("stores the latest report per domain without per-visitor changes", async () => {
    const store = memStore();
    await runAnalysis(request(policyText(NO_REFUND)), { store, llm: new MockLlm() });
    const latest = store.getLatestReport("shop.example.com");
    expect(latest?.verdict).toBe("red");
    expect(latest?.changes).toBeUndefined();
  });
});
