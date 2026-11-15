import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GoldenSchema, type Golden } from "@xcavate/shared";
import { describe, expect, it } from "vitest";
import { fixtureUrl, loadFixture } from "../../fixtures/load";
import { postAnalyze } from "../src/background/api";
import { collectPolicies } from "../src/content/collect";
import { htmlDoc } from "./helpers";

/**
 * Optional live contract check: the extension's own collector on each fixture checkout, posted to a
 * running backend. Skipped unless XCAVATE_API is set, e.g.
 *   XCAVATE_API=http://localhost:8787 npx vitest run --project extension backend.live
 */
const API = process.env.XCAVATE_API;
const golden: Golden = GoldenSchema.parse(JSON.parse(readFileSync(join(__dirname, "../../fixtures/golden.json"), "utf8")));

function serveFixture(url: string): string | undefined {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const site = (u.port === "4001" ? parts[0] : u.hostname.split(".")[0]) as "gadgetly";
  const page = (u.port === "4001" ? parts[1] : parts[0]) ?? "index";
  try {
    return loadFixture(site, page);
  } catch {
    return undefined;
  }
}

describe.runIf(!!API)("live backend contract", () => {
  for (const g of golden.sites.filter((s) => s.checkoutPath === "/checkout")) {
    it(`${g.id} → ${g.verdict}`, async () => {
      const url = fixtureUrl(g.id as "gadgetly", "checkout");
      const req = await collectPolicies(htmlDoc(loadFixture(g.id as "gadgetly", "checkout"), url), url, "checkout", {
        fetchHtml: async (u) => serveFixture(u),
      });
      // jsdom's AbortSignal is not Node's, so drop it for Node's fetch in this test.
      const fetchImpl = ((u: string, init?: RequestInit) => fetch(u, { ...init, signal: undefined })) as typeof fetch;
      const report = await postAnalyze(API!, req, { fetchImpl });
      expect(report.verdict).toBe(g.verdict);
      const cats = report.flags.map((f) => f.category);
      for (const c of g.categories) expect(cats).toContain(c);
      for (const c of g.forbidden ?? []) expect(cats).not.toContain(c);
    }, 30_000);
  }
});
