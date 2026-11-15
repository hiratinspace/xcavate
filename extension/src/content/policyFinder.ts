import { stripPageUrl, type PolicyKind } from "@xcavate/shared/core";
import { cleanText } from "../lib/dom";
import { isFetchAllowed } from "../lib/netguard";

/** D-03 policy link finder (BUILD_PLAN 7.2). */

export interface PolicyLink {
  /** Identity of the policy: origin + path, no query or hash. This is what is sent, stored and shown. */
  url: string;
  kind: Exclude<PolicyKind, "other">;
  /** Full URL (query kept, hash dropped) used only to fetch, when it differs from `url`. */
  fetchUrl?: string;
}

interface Candidate extends PolicyLink {
  priority: number;
  agree: boolean;
  order: number;
  /** 2: the link text names a document ("Refund Policy"), 1: the text names a kind ("Returns"), 0: generic text or path only. */
  quality: number;
  /** False for index pages ("/legal/", "/policies") that list documents instead of being one. */
  leaf: boolean;
  /** How many links on the page point here: the offer's own "Terms apply" links repeat. */
  hits: number;
}

const KINDS: { kind: PolicyLink["kind"]; re: RegExp; priority: number }[] = [
  // Word boundaries at the start so a brand like "SneakyTerms" is not a terms link.
  { kind: "subscription", re: /\bsubscription|\bbilling|\bauto.?renew|\bmembership terms/i, priority: 1 },
  { kind: "refund", re: /\brefund|\breturn|\bcancell?ation/i, priority: 2 },
  { kind: "terms", re: /\bterms\b|\bconditions\b|\btos\b|\buser agreement|\bsubscriber agreement|\bmembership agreement|\bterms of use|\bterms apply|\btermsofuse|\btermsandconditions/i, priority: 3 },
  { kind: "privacy", re: /\bprivacy/i, priority: 4 },
];
/** "Legal" on its own is a terms link only as a last resort: "/legal/privacy-policy" is the privacy policy. */
const LEGAL = /\blegal\b/i;
const TERMS_PRIORITY = 3;

/** Link text that names a document, not just a topic. Beats a match on the URL path alone. */
const DOC_TEXT =
  /\b(terms|conditions)\s+(of|and|&)\s+(service|use|sale|sales|membership|business|purchase)\b|\bterms (and|&) conditions\b|\b(refund|returns?|cancell?ation|subscription|billing|membership|privacy|shipping (and|&) returns?)\s+(policy|policies|terms|notice|agreement|statement)\b|\b(subscriber|user|membership|customer|subscription|service|license|licence)\s+agreement\b|\bterms of (service|use)\b|\btos\b/i;
/** Text that only names a topic or a section ("Legal", "Billing"): weakest evidence there is. */
const GENERIC_TEXT = /^(legal( (info|information|notices?|center|centre|hub|stuff))?|subscriptions?|billing|membership|plans?|policies)$/i;

/**
 * Links that look like policies but are not a document a shopper agrees to when paying: product
 * listings ("/collections/subscription-add-ons"), the checkout or billing app itself, account and
 * subscription management, cookie notices, business/enterprise contracts, partner programmes.
 */
const EXCLUDE_PATH =
  /\/(collections|products?|commerce|checkouts?|cart|basket|account|accounts|my-account|myaccount|login|signin|sign-in|logout|search|blog|news|press|careers|jobs)(\/|$)|\bmanage\b|for-business|\/business(\/|$)|business-(agreement|terms)|customer-business|enterprise|\bmsa\b|master-?services|\b(partner|affiliate|seller|vendor|supplier|merchant|advertis\w*|developer|api)[-_](terms|agreement|policy|program)/i;
const EXCLUDE_TEXT =
  /\bmanage\b|\bsign ?in\b|\blog ?in\b|\bmy account\b|\bfor business\b|\bbusiness (terms|agreement)\b|\benterprise\b|\bmaster services?\b|\bmsa\b|\bprivacy choices\b|\bdo not sell\b|\bopt.?out\b|\bad ?choices\b|\binterest.based\b|\b(partner|affiliate|seller|vendor|merchant|developer|advertiser|api)s? (terms|agreement|policy|program)/i;
/** Cookie notices are excluded unless the same link is also the privacy policy ("Privacy and Cookie Policy"). */
const COOKIE = /cookie/i;
/** Help-centre and policy index pages, not documents: "/help", "/hc/en-us", "/hc/en-us/categories/…". */
const HELP_INDEX = /^\/((help|support|faq|help-?center|helpcentre)\/?|hc\/[a-z-]+\/?|hc\/[a-z-]+\/(categories|sections)\/.*)$/i;
const INDEX_LEAF = /^(legal|policies|policy|terms-index|legal-center|legal-centre|legal-hub|legal-information|legal-notices|about|info|[a-z]{2}(-[a-z]{2})?)$/i;

/** Link text that mentions "return" but is navigation, not a policy. */
const NAV_TEXT = /\b(return|back|go back) to\b|\bcontinue shopping\b/i;
const AGREE = /\b(agree|accept|consent|acknowledge)\b/i;
const MAX_TOTAL = 4;
const MAX_PER_KIND = 2;
/** Privacy never drives the verdict (money first): one privacy document is enough, the slot goes to money terms. */
const MAX_PRIVACY = 1;

export const WELL_KNOWN_PATHS: { path: string; kind: PolicyLink["kind"] }[] = [
  // V-10: Shopify stores serve their policies here, whatever the theme links to.
  { path: "/policies/refund-policy", kind: "refund" },
  { path: "/policies/terms-of-service", kind: "terms" },
  { path: "/policies/subscription-policy", kind: "subscription" },
  { path: "/terms", kind: "terms" },
  { path: "/terms-of-service", kind: "terms" },
  { path: "/refund-policy", kind: "refund" },
  { path: "/returns", kind: "refund" },
  { path: "/legal/terms", kind: "terms" },
];

function kindOf(s: string): { kind: PolicyLink["kind"]; priority: number } | undefined {
  for (const k of KINDS) if (k.re.test(s)) return k;
  if (LEGAL.test(s)) return { kind: "terms", priority: TERMS_PRIORITY };
  return undefined;
}

/** True when the URL is not a policy document even though its words look like one. */
function excludedPath(path: string): boolean {
  if (HELP_INDEX.test(path) || EXCLUDE_PATH.test(path)) return true;
  return COOKIE.test(path) && !/privacy/i.test(path);
}

function excludedText(text: string): boolean {
  if (EXCLUDE_TEXT.test(text)) return true;
  return COOKIE.test(text) && !/\bprivacy\b|\bterms\b/i.test(text);
}

/** "/legal/", "/us/legal", "/policies" and similar: a list of documents, not one of them. */
function isLeaf(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  if (!segs.length) return false;
  return !INDEX_LEAF.test(segs[segs.length - 1].replace(/\.(html?|php|aspx?)$/i, ""));
}

/** Side documents ("California Privacy Notice", "Children's Privacy Policy"): the main one comes first. */
const SIDE_DOC = /\b(children|kids|california|state|health|notice at collection|eu|uk|cookie)\b/i;

function textQuality(text: string, kind: PolicyLink["kind"]): number {
  if (DOC_TEXT.test(text)) return SIDE_DOC.test(text) ? 1 : 2;
  // A sentence ("Learn more about our security and privacy practices here") is a link to an article.
  if (text.length > 60 || GENERIC_TEXT.test(text.replace(/[.:!]+$/, "").trim())) return 0;
  // "Gift Subscription", "Group Subscriptions": product pages. A subscription document names itself.
  if (kind === "subscription") return 0;
  // "Terms apply", "Returns", "Refunds": the text names the kind, but not a document.
  return KINDS.some((k) => k.kind === kind && k.re.test(text)) ? 1 : 0;
}

/** "Safety & Privacy Center", "Legal hub": an index of documents. */
const INDEX_TEXT = /\b(center|centre|hub|overview)\b/i;

function withoutHash(u: URL): string {
  const c = new URL(u.href);
  c.hash = "";
  return c.href;
}

/** decodeURIComponent that never throws on malformed escapes like /caf%E9 or /50%-off. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const INLINE = new Set(["A", "SPAN", "STRONG", "B", "EM", "I", "SMALL", "U", "MARK", "SUP", "SUB"]);

/** True when the anchor sits in the "By placing your order you agree to…" sentence (its nearest block). */
function inAgreeSentence(a: Element): boolean {
  let el: Element | null = a.parentElement;
  while (el && INLINE.has(el.tagName.toUpperCase()) && el.parentElement) el = el.parentElement;
  if (!el) return false;
  const text = cleanText(el.textContent);
  return text.length <= 600 && AGREE.test(text);
}

/** Every distinct policy-looking link on the page, best first. */
export function findPolicyCandidates(doc: Document, pageUrl: string): Candidate[] {
  const pageKey = stripPageUrl(pageUrl);
  const seen = new Map<string, Candidate>();
  let order = 0;
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    // Empty, "#", "#modal-…" and javascript: links are in-page widgets, not policies ("Terms apply"
    // modals on streaming sites). They are skipped before they can use up a kind's quota.
    const href = (a.getAttribute("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, doc.baseURI && doc.baseURI !== "about:blank" ? doc.baseURI : pageUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    // Never collect links into the shopper's local network (router pages, intranet) from a public page.
    if (!isFetchAllowed(u.href, pageUrl)) continue;
    const key = u.origin + u.pathname; // query + hash dropped: they can carry session ids or emails
    if (key === pageKey) continue;
    if (u.pathname === "/") continue; // a policy is never the home page (logo links)

    const text = cleanText(a.textContent || a.getAttribute("aria-label") || a.getAttribute("title"));
    const path = safeDecode(u.pathname);
    if (excludedPath(path) || (text && excludedText(text))) continue;
    let match = text && !NAV_TEXT.test(text) ? kindOf(text) : undefined;
    const fromText = !!match;
    if (!match) match = kindOf(path.replace(/[-_]/g, " "));
    if (!match) continue;
    const quality = fromText ? textQuality(text, match.kind) : 0;
    const leaf = isLeaf(path) && !(text && INDEX_TEXT.test(text));

    const agree = inAgreeSentence(a);
    const prev = seen.get(key);
    if (prev) {
      // Same URL linked twice: keep the stronger reading of it.
      if (agree && !prev.agree) prev.agree = true;
      prev.hits++;
      if (quality > prev.quality || (quality === prev.quality && match.priority < prev.priority))
        Object.assign(prev, { kind: match.kind, priority: match.priority, quality });
      continue;
    }
    const full = withoutHash(u);
    const c: Candidate = { url: key, kind: match.kind, priority: match.priority, agree, order: order++, quality, leaf, hits: 1 };
    if (full !== key) c.fetchUrl = full;
    seen.set(key, c);
  }
  // Order: links in the "you agree to" sentence next to the pay button, then any link whose text
  // names the policy, then kind (money first), then documents before index pages, then page order.
  return Array.from(seen.values()).sort(
    (x, y) =>
      Number(y.agree) - Number(x.agree) ||
      Number(y.quality > 0) - Number(x.quality > 0) ||
      x.priority - y.priority ||
      y.quality - x.quality ||
      Number(y.leaf) - Number(x.leaf) ||
      y.hits - x.hits ||
      x.order - y.order,
  );
}

/** At most 4 links, at most 2 per kind (1 privacy), absolute http(s) URLs, no duplicates. */
export function findPolicies(doc: Document, pageUrl: string): PolicyLink[] {
  return capPolicies(findPolicyCandidates(doc, pageUrl));
}

export function capPolicies(candidates: Candidate[]): PolicyLink[] {
  const out: PolicyLink[] = [];
  const perKind = new Map<string, number>();
  // A weak candidate (generic text or a path match only, or an index page) only fills a slot when
  // the page offers little else: with two named documents, or a named one of its kind, it is noise.
  const named = candidates.filter((c) => c.quality > 0 && c.leaf);
  const namedKinds = new Set(named.map((c) => c.kind));
  for (const c of candidates) {
    if (out.length >= MAX_TOTAL) break;
    const weak = c.quality === 0 || !c.leaf;
    if (weak && !c.agree && (named.length >= 2 || namedKinds.has(c.kind))) continue;
    const n = perKind.get(c.kind) ?? 0;
    if (n >= (c.kind === "privacy" ? MAX_PRIVACY : MAX_PER_KIND)) continue;
    perKind.set(c.kind, n + 1);
    out.push(c.fetchUrl ? { url: c.url, kind: c.kind, fetchUrl: c.fetchUrl } : { url: c.url, kind: c.kind });
  }
  return out;
}

/**
 * Fallback when no link was found: probe well-known same-origin paths and keep the first two
 * that answer 200. `probe` returns the HTML for a URL, or undefined when it is not a 200.
 */
export async function findWellKnown(
  pageUrl: string,
  probe: (url: string) => Promise<string | undefined>,
): Promise<{ link: PolicyLink; html: string }[]> {
  const origin = new URL(pageUrl).origin;
  const found: { link: PolicyLink; html: string }[] = [];
  for (const { path, kind } of WELL_KNOWN_PATHS) {
    if (found.length >= 2) break;
    const url = origin + path;
    const html = await probe(url).catch(() => undefined);
    if (html !== undefined) found.push({ link: { url, kind }, html });
  }
  return found;
}
