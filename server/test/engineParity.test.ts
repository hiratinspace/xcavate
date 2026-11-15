import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GoldenSchema, ReportSchema } from "@xcavate/shared";
import type { AnalyzeRequest, Report } from "@xcavate/shared";
import { runRulesOnly } from "@xcavate/shared/engine";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../fixtures/load.js";
import { FIXTURE_CASES, STREAMNEST_V2, buildRequest, caseById } from "../scripts/fixtureRequests.js";
import { MockLlm } from "../src/llm/mock.js";
import { runAnalysis } from "../src/pipeline/run.js";
import { failingLlm, memStore, policyText, request } from "./helpers.js";

/**
 * V-06: the extension's on-device verdict (runRulesOnly from the shared engine) must match the
 * server in mock mode, flag for flag, so the first card never disagrees with the server's rules.
 */

const golden = GoldenSchema.parse(JSON.parse(readFileSync(join(FIXTURES_DIR, "golden.json"), "utf8")));

/** Everything that drives what the user sees, minus timing and cache fields. */
function shape(r: Report) {
  return {
    domain: r.domain,
    verdict: r.verdict,
    flags: r.flags.map((f) => ({ ...f })),
    trial: r.trial,
    cancellation: r.cancellation,
    policies: r.policies,
    usedLlm: r.stats.usedLlm,
  };
}

async function both(req: AnalyzeRequest) {
  const local = await runRulesOnly(req);
  const server = await runAnalysis(req, { store: memStore(), llm: new MockLlm() });
  return { local, server };
}

const CASES = [...FIXTURE_CASES, STREAMNEST_V2];

describe("runRulesOnly matches the server in mock mode", () => {
  it.each(CASES.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const { local, server } = await both(buildRequest(c));
    expect(ReportSchema.safeParse(local).success).toBe(true);
    expect(local.stats.usedLlm).toBe(false);
    expect(local.cached).toBe(false);
    expect(local.changes).toBeUndefined();
    expect(shape(local)).toEqual(shape(server));
  });

  it.each(golden.sites.map((s) => [s.id, s] as const))("golden %s on device", async (id, site) => {
    const r = await runRulesOnly(buildRequest(caseById(id)));
    const got = r.flags.map((f) => f.category);
    expect(r.verdict).toBe(site.verdict);
    for (const cat of site.categories) expect(got).toContain(cat);
    for (const cat of site.forbidden ?? []) expect(got).not.toContain(cat);
  });

  it("equals the server's rules-only fallback when the model fails (same code path)", async () => {
    for (const c of CASES) {
      const req = buildRequest(c);
      const local = await runRulesOnly(req);
      const server = await runAnalysis(req, { store: memStore(), llm: failingLlm() });
      expect(shape(local)).toEqual(shape(server));
    }
  });

  it("missing_policy, partial and unknown agree with the server", async () => {
    const privacy = policyText("We share your email address with advertising partners for marketing purposes.");
    const reqs: AnalyzeRequest[] = [
      { pageUrl: "https://shop.example.com/checkout", pageType: "checkout", linksFound: 0, policies: [] },
      request(privacy, { policies: [{ url: "https://shop.example.com/privacy", kind: "privacy", text: privacy }] }),
      request("too short"),
      request(policyText("Your membership renews automatically every month until you cancel. To cancel, you must call us at 1-800-555-0199.")),
    ];
    const verdicts: string[] = [];
    for (const req of reqs) {
      const { local, server } = await both(req);
      expect(shape(local)).toEqual(shape(server));
      verdicts.push(local.verdict);
    }
    expect(verdicts.slice(0, 3)).toEqual(["yellow", "partial", "unknown"]);
    const { local } = await both(reqs[3]);
    expect(local.flags.some((f) => f.rightsNote)).toBe(true);
  });
});
