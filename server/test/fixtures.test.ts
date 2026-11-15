import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GoldenSchema, normalizeForMatch } from "@xcavate/shared";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../fixtures/load.js";
import { FIXTURE_CASES, STREAMNEST_V2, buildRequest, caseById, policyText } from "../scripts/fixtureRequests.js";
import { MockLlm } from "../src/llm/mock.js";
import { prefilter } from "../src/pipeline/prefilter.js";
import { runAnalysis } from "../src/pipeline/run.js";
import { splitParagraphs } from "../src/pipeline/split.js";
import { failingLlm, memStore } from "./helpers.js";

const golden = GoldenSchema.parse(JSON.parse(readFileSync(join(FIXTURES_DIR, "golden.json"), "utf8")));

describe("golden verdicts (LLM_PROVIDER=mock)", () => {
  it.each(golden.sites.map((s) => [s.id, s] as const))("%s", async (id, site) => {
    const r = await runAnalysis(buildRequest(caseById(id)), { store: memStore(), llm: new MockLlm() });
    const got = r.flags.map((f) => f.category);
    expect(r.verdict).toBe(site.verdict);
    for (const c of site.categories) expect(got).toContain(c);
    for (const c of site.forbidden ?? []) expect(got).not.toContain(c);
    expect(r.stats.droppedUnverified).toBe(0);
  });

  it.each(golden.sites.map((s) => [s.id, s] as const))("%s, rules only (LLM offline)", async (id, site) => {
    const r = await runAnalysis(buildRequest(caseById(id)), { store: memStore(), llm: failingLlm() });
    expect(r.verdict).toBe(site.verdict);
    expect(r.stats.usedLlm).toBe(false);
  });
});

/** The planted sentences per store (docs/fixtures-contract.md). */
const PLANTED: Record<string, { page: string; phrases: string[] }[]> = {
  streamnest: [
    { page: "subscription", phrases: ["7-day free trial", "$14.99 per month", "renews automatically each month until you cancel"] },
    { page: "terms", phrases: ["must be made by telephone", "30 days' notice"] },
  ],
  gadgetly: [
    { page: "returns", phrases: ["restocking fee of 25%", "cost of return shipping"] },
    { page: "terms", phrases: ["binding individual arbitration"] },
  ],
  sneakyterms: [{ page: "terms", phrases: ["all sales are final", "early termination fee of $75.00"] }],
  fairbox: [{ page: "refunds", phrases: ["we do not charge a restocking fee"] }],
};

describe("prefilter on fixtures", () => {
  it.each(Object.entries(PLANTED))("%s: every planted clause survives", (site, pages) => {
    for (const { page, phrases } of pages) {
      const paras = splitParagraphs(policyText(site as never, page));
      const kept = prefilter([{ paragraphs: paras }]).kept[0].map((p) => normalizeForMatch(p.text)).join("\n");
      for (const ph of phrases) expect(kept, `${site}/${page}: ${ph}`).toContain(normalizeForMatch(ph));
    }
  });

  it("drops FairBox boilerplate (about us, intellectual property, etc.)", () => {
    for (const page of ["terms", "privacy", "refunds"]) {
      const paras = splitParagraphs(policyText("fairbox", page));
      const { kept } = prefilter([{ paragraphs: paras }]);
      expect(kept[0].length, page).toBeLessThan(paras.length);
    }
    const terms = splitParagraphs(policyText("fairbox", "terms"));
    const kept = new Set(prefilter([{ paragraphs: terms }]).kept[0].map((p) => p.index));
    const dropped = terms.filter((p) => !kept.has(p.index)).map((p) => p.text.toLowerCase()).join("\n");
    expect(dropped).toMatch(/about|intellectual|trademark|content|website|feedback/);
  });
});

describe("trial and cancellation (A-10)", () => {
  it("StreamNest: 7 days, $14.99, phone, 30 days", async () => {
    const r = await runAnalysis(buildRequest(caseById("streamnest")), { store: memStore(), llm: new MockLlm() });
    expect(r.trial).toMatchObject({ lengthDays: 7, priceAfter: "$14.99", billingPeriod: "month" });
    expect(r.cancellation).toMatchObject({ method: "phone", noticeDays: 30, contact: "1-800-555-0199" });
    expect(r.cancellation!.steps.length).toBeGreaterThan(0);
    expect(r.cancellation!.steps.length).toBeLessThanOrEqual(4);
  });

  it("StreamNest rules fallback gives the same with the LLM offline", async () => {
    const r = await runAnalysis(buildRequest(caseById("streamnest")), { store: memStore(), llm: failingLlm() });
    expect(r.trial).toMatchObject({ lengthDays: 7, priceAfter: "$14.99" });
    expect(r.cancellation).toMatchObject({ method: "phone", noticeDays: 30 });
  });

  it("FairBox: both undefined", async () => {
    const r = await runAnalysis(buildRequest(caseById("fairbox")), { store: memStore(), llm: new MockLlm() });
    expect(r.trial).toBeUndefined();
    expect(r.cancellation).toBeUndefined();
  });
});

describe("change summary (A-11)", () => {
  it("StreamNest v1 -> v2 mentions the new price and the termination fee", async () => {
    const store = memStore();
    const llm = new MockLlm();
    const v1 = await runAnalysis(buildRequest(FIXTURE_CASES[0]), { store, llm });
    expect(v1.changes).toBeUndefined();
    const prev = Object.fromEntries(v1.policies.map((p) => [p.url, p.textHash]));
    const v2 = await runAnalysis(buildRequest(STREAMNEST_V2, prev), { store, llm });
    expect(v2.changes?.length).toBeGreaterThan(0);
    const text = v2.changes!.flatMap((c) => c.bullets).join(" ").toLowerCase();
    expect(text).toContain("$19.99");
    expect(text).toContain("termination fee");
    expect(v2.changes!.every((c) => c.moneyRelevant && c.bullets.length <= 3)).toBe(true);
    // The privacy page did not change, so it has no entry.
    expect(v2.changes!.some((c) => c.policyUrl.endsWith("/privacy"))).toBe(false);
    expect(v2.flags.map((f) => f.category)).toContain("termination_fee");
  });

  it("works the same when the LLM is offline (rules bullets)", async () => {
    const store = memStore();
    const v1 = await runAnalysis(buildRequest(FIXTURE_CASES[0]), { store, llm: failingLlm() });
    const prev = Object.fromEntries(v1.policies.map((p) => [p.url, p.textHash]));
    const v2 = await runAnalysis(buildRequest(STREAMNEST_V2, prev), { store, llm: failingLlm() });
    const text = v2.changes!.flatMap((c) => c.bullets).join(" ").toLowerCase();
    expect(text).toContain("$19.99");
    expect(text).toContain("termination fee");
  });

  it("unchanged policy -> no changes field", async () => {
    const store = memStore();
    const v1 = await runAnalysis(buildRequest(FIXTURE_CASES[0]), { store, llm: new MockLlm() });
    const prev = Object.fromEntries(v1.policies.map((p) => [p.url, p.textHash]));
    const again = await runAnalysis(buildRequest(FIXTURE_CASES[0], prev), { store, llm: new MockLlm() });
    expect(again.changes).toBeUndefined();
    expect(again.cached).toBe(true);
  });

  it("unknown previous text -> no changes field", async () => {
    const r = await runAnalysis(
      buildRequest(STREAMNEST_V2, { "http://streamnest.localhost:4000/subscription": "f".repeat(64) }),
      { store: memStore(), llm: new MockLlm() },
    );
    expect(r.changes).toBeUndefined();
  });
});
