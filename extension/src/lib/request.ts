import { LIMITS, stripPageUrl, type AnalyzeRequest, type PageType, type PolicyInput } from "@xcavate/shared/core";

/**
 * Builds the only object that ever leaves the browser: page and policy URLs without query or hash,
 * the page type, a link count, and public policy text. Every field is copied by name,
 * so nothing else (cart, form contents, fees) can ride along.
 */
export function buildAnalyzeRequest(input: {
  pageUrl: string;
  pageType: PageType;
  linksFound: number;
  policies: { url: string; kind: PolicyInput["kind"]; text: string; previousHash?: string }[];
}): AnalyzeRequest {
  return {
    pageUrl: stripPageUrl(input.pageUrl),
    pageType: input.pageType,
    linksFound: Math.max(0, Math.min(1000, Math.floor(input.linksFound))),
    policies: input.policies.slice(0, LIMITS.maxPolicies).map((p) => {
      const out: PolicyInput = { url: stripPageUrl(p.url), kind: p.kind, text: p.text.slice(0, LIMITS.maxPolicyChars) };
      if (p.previousHash && /^[0-9a-f]{64}$/.test(p.previousHash)) out.previousHash = p.previousHash;
      return out;
    }),
  };
}
