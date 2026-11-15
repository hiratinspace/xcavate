import { lpNormalize } from "./textutil.js";

/**
 * Document scope (direction v3). Xcavate warns shoppers, so a contract written for business
 * customers (enterprise terms, a master services agreement, a reseller or merchant agreement) is
 * not evidence about what a consumer pays. The extension also skips such links when it finds
 * policies; this is defence in depth where the engine knows the URL and the opening text.
 */

const BUSINESS_PATH =
  /(^|[/_.-])(business|enterprise|b2b|msa|master[-_]?services?|reseller|resellers|merchant|merchants|wholesale|partner[-_]?program|advertisers?|developer[-_]?terms|api[-_]?terms|customer[-_]business[-_]agreement)([/_.-]|$)/;

const BUSINESS_TITLE =
  /\b(customer business agreement|master (services|subscription) agreement|enterprise (terms|agreement|subscription agreement|customer agreement)|business (terms|customer agreement|services agreement)|terms (of service )?for business(es)?|for business customers|reseller agreement|merchant (agreement|terms)|wholesale (terms|agreement)|advertiser (terms|agreement))\b/;

/** Consumer wording that keeps a document in scope even if its URL says "business" ("small business owners too"). */
const CONSUMER_MARK = /\b(consumers?|personal, non-commercial|individual (subscriber|user|customer)s?)\b/;

/** True when the policy URL path or the document's opening reads as a business-customer contract. */
export function isBusinessDocument(url: string, text: string): boolean {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  const head = lpNormalize(text.slice(0, 600));
  const pathHit = BUSINESS_PATH.test(path);
  const titleHit = BUSINESS_TITLE.test(head);
  if (!pathHit && !titleHit) return false;
  // A path hit alone yields to consumer wording in the opening; a business title in the opening is enough.
  return titleHit || !CONSUMER_MARK.test(head);
}
