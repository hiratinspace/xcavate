import type { PolicyKind } from "@xcavate/shared";
import { cleanText } from "../lib/dom";

/** D-03 policy link finder (BUILD_PLAN 7.2). */

export interface PolicyLink {
  url: string;
  kind: Exclude<PolicyKind, "other">;
}

interface Candidate extends PolicyLink {
  priority: number;
  agree: boolean;
  order: number;
}

const KINDS: { kind: PolicyLink["kind"]; re: RegExp; priority: number }[] = [
  // Word boundaries at the start so a brand like "SneakyTerms" is not a terms link.
  { kind: "subscription", re: /\bsubscription|\bbilling|\bauto.?renew|\bmembership terms/i, priority: 1 },
  { kind: "refund", re: /\brefund|\breturn|\bcancell?ation/i, priority: 2 },
  { kind: "terms", re: /\bterms\b|\bconditions\b|\btos\b|\buser agreement|\bsubscriber agreement|\bmembership agreement|\bterms of use|\bterms apply|\blegal\b/i, priority: 3 },
  { kind: "privacy", re: /\bprivacy/i, priority: 4 },
];

/** Link text that mentions "return" but is navigation, not a policy. */
const NAV_TEXT = /\b(return|back|go back) to\b|\bcontinue shopping\b/i;
const AGREE = /\b(agree|accept|consent|acknowledge)\b/i;
const MAX_TOTAL = 4;
const MAX_PER_KIND = 2;

export const WELL_KNOWN_PATHS: { path: string; kind: PolicyLink["kind"] }[] = [
  { path: "/terms", kind: "terms" },
  { path: "/terms-of-service", kind: "terms" },
  { path: "/refund-policy", kind: "refund" },
  { path: "/returns", kind: "refund" },
  { path: "/legal/terms", kind: "terms" },
];

function kindOf(s: string): { kind: PolicyLink["kind"]; priority: number } | undefined {
  for (const k of KINDS) if (k.re.test(s)) return k;
  return undefined;
}

function withoutHash(u: URL): string {
  const c = new URL(u.href);
  c.hash = "";
  return c.href;
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
  const page = new URL(pageUrl);
  const pageKey = withoutHash(page);
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
    const key = withoutHash(u);
    if (key === pageKey) continue;
    if (u.pathname === "/" && !u.search) continue; // a policy is never the home page (logo links)

    const text = cleanText(a.textContent || a.getAttribute("aria-label") || a.getAttribute("title"));
    let match = text && !NAV_TEXT.test(text) ? kindOf(text) : undefined;
    if (!match) match = kindOf(decodeURIComponent(u.pathname));
    if (!match) continue;

    const agree = inAgreeSentence(a);
    const prev = seen.get(key);
    if (prev) {
      // Same URL linked twice: keep the stronger reading of it.
      if (agree && !prev.agree) prev.agree = true;
      if (match.priority < prev.priority) Object.assign(prev, { kind: match.kind, priority: match.priority });
      continue;
    }
    seen.set(key, { url: key, kind: match.kind, priority: match.priority, agree, order: order++ });
  }
  return Array.from(seen.values()).sort(
    (x, y) => Number(y.agree) - Number(x.agree) || x.priority - y.priority || x.order - y.order,
  );
}

/** At most 4 links, at most 2 per kind, absolute http(s) URLs, no duplicates. */
export function findPolicies(doc: Document, pageUrl: string): PolicyLink[] {
  return capPolicies(findPolicyCandidates(doc, pageUrl));
}

export function capPolicies(candidates: Candidate[]): PolicyLink[] {
  const out: PolicyLink[] = [];
  const perKind = new Map<string, number>();
  for (const c of candidates) {
    if (out.length >= MAX_TOTAL) break;
    const n = perKind.get(c.kind) ?? 0;
    if (n >= MAX_PER_KIND) continue;
    perKind.set(c.kind, n + 1);
    out.push({ url: c.url, kind: c.kind });
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
