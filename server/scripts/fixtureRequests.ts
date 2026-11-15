import type { AnalyzeRequest, PolicyKind } from "@xcavate/shared";
import { stripPageUrl } from "@xcavate/shared";
import { fixtureUrl, loadFixture } from "../../fixtures/load.js";
import type { Site } from "../../fixtures/load.js";
import { htmlToText } from "../src/extract/html.js";

/**
 * AnalyzeRequests built from the fixture stores, the way the extension would send them:
 * policy HTML from disk, cleaned with the server-side extractor, at the URLs from
 * fixtures/README.md. Used by the seed script, the eval and the integration tests.
 */

export interface FixtureCase {
  /** golden.json site id */
  id: string;
  site: Site;
  /** Page the request comes from. */
  page: string;
  pageType: AnalyzeRequest["pageType"];
  /** Policy pages and their kinds. `file` is the HTML file when it differs from the served page. */
  policies: { page: string; kind: PolicyKind; file?: string }[];
}

export const FIXTURE_CASES: FixtureCase[] = [
  {
    id: "streamnest",
    site: "streamnest",
    page: "checkout",
    pageType: "checkout",
    policies: [
      { page: "subscription", kind: "subscription" },
      { page: "terms", kind: "terms" },
      { page: "privacy", kind: "privacy" },
    ],
  },
  {
    id: "gadgetly",
    site: "gadgetly",
    page: "checkout",
    pageType: "checkout",
    policies: [
      { page: "returns", kind: "refund" },
      { page: "terms", kind: "terms" },
      { page: "privacy", kind: "privacy" },
    ],
  },
  {
    id: "fairbox",
    site: "fairbox",
    page: "checkout",
    pageType: "checkout",
    policies: [
      { page: "refunds", kind: "refund" },
      { page: "terms", kind: "terms" },
      { page: "privacy", kind: "privacy" },
    ],
  },
  {
    id: "sneakyterms",
    site: "sneakyterms",
    page: "checkout",
    pageType: "checkout",
    policies: [
      { page: "terms", kind: "terms" },
      { page: "privacy", kind: "privacy" },
    ],
  },
  {
    // Manual "Scan this page" on the variant whose instruction sits inside a quotation.
    id: "sneakyterms_quoted",
    site: "sneakyterms",
    page: "terms-quoted",
    pageType: "none",
    policies: [{ page: "terms-quoted", kind: "other" }],
  },
];

/** StreamNest after `GET /__set?site=streamnest&v=2`: same URLs, v2 files. */
export const STREAMNEST_V2: FixtureCase = {
  ...FIXTURE_CASES[0],
  id: "streamnest_v2",
  policies: [
    { page: "subscription", kind: "subscription", file: "subscription.v2" },
    { page: "terms", kind: "terms", file: "terms.v2" },
    { page: "privacy", kind: "privacy" },
  ],
};

export function caseById(id: string): FixtureCase {
  const c = [...FIXTURE_CASES, STREAMNEST_V2].find((x) => x.id === id);
  if (!c) throw new Error("unknown fixture case " + id);
  return c;
}

export function policyText(site: Site, file: string): string {
  return htmlToText(loadFixture(site, file)).text;
}

export function buildRequest(c: FixtureCase, previousHashes: Record<string, string> = {}): AnalyzeRequest {
  return {
    pageUrl: stripPageUrl(fixtureUrl(c.site, c.page)),
    pageType: c.pageType,
    linksFound: c.policies.length,
    policies: c.policies.map((p) => {
      const url = fixtureUrl(c.site, p.page);
      const prev = previousHashes[url];
      return {
        url,
        kind: p.kind,
        text: policyText(c.site, p.file ?? p.page),
        ...(prev ? { previousHash: prev } : {}),
      };
    }),
  };
}
