import { MSG, type AnalyzeRequest, type FetchHtmlReply, type PageType } from "@xcavate/shared";
import { fetchCapped } from "../lib/fetchCapped";
import { send } from "../lib/messaging";
import { buildAnalyzeRequest } from "../lib/request";
import { extractFromHtml } from "./extractor";
import { capPolicies, findPolicyCandidates, findWellKnown, type PolicyLink } from "./policyFinder";

export interface FetchedPage {
  html: string;
  /** URL after redirects; this is the policy URL sent to the backend and used for "See in policy". */
  finalUrl: string;
}

/** Fetch a policy page: same origin directly, other origins through the service worker. */
export async function fetchPolicyHtml(url: string, pageUrl: string): Promise<FetchedPage | undefined> {
  if (new URL(url).origin === new URL(pageUrl).origin) {
    const r = await fetchCapped(url);
    return r.ok && r.html !== undefined ? { html: r.html, finalUrl: cleanFinal(r.finalUrl, url) } : undefined;
  }
  const r = await send<FetchHtmlReply>({ type: MSG.FETCH_HTML, url });
  return r?.ok && r.html !== undefined ? { html: r.html, finalUrl: cleanFinal(r.finalUrl, url) } : undefined;
}

/** Keep the redirect target if it is a valid http(s) URL; drop its hash. */
function cleanFinal(finalUrl: string | undefined, fallback: string): string {
  try {
    const u = new URL(finalUrl || fallback);
    if (u.protocol !== "http:" && u.protocol !== "https:") return fallback;
    u.hash = "";
    return u.href;
  } catch {
    return fallback;
  }
}

/**
 * Resolves once the DOM has been quiet for `quietMs` (or after `maxMs`). JS-rendered pages add
 * their footer links late, so the finder retries once after this when its first pass found nothing.
 */
export function waitForDomQuiet(doc: Document, quietMs = 1000, maxMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(cap);
      mo.disconnect();
      resolve();
    };
    const mo = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    });
    mo.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
    quiet = setTimeout(done, quietMs);
    const cap = setTimeout(done, maxMs);
  });
}

export interface CollectDeps {
  /** Returns the page (with its final URL after redirects), or undefined when it is not a 200. Plain strings are accepted too. */
  fetchHtml?: (url: string, pageUrl: string) => Promise<FetchedPage | string | undefined>;
  /** Called when the first pass finds no links; resolve when it is worth looking again. */
  settle?: () => Promise<void>;
}

function asPage(r: FetchedPage | string | undefined, url: string): FetchedPage | undefined {
  if (r === undefined) return undefined;
  return typeof r === "string" ? { html: r, finalUrl: url } : r;
}

/** D-03 + D-04: find policy links, fetch and clean them, and build the AnalyzeRequest. */
export async function collectPolicies(
  doc: Document,
  pageUrl: string,
  pageType: PageType,
  deps: CollectDeps = {},
): Promise<AnalyzeRequest> {
  const fetchHtml = deps.fetchHtml ?? fetchPolicyHtml;
  let candidates = findPolicyCandidates(doc, pageUrl);
  if (!candidates.length && deps.settle) {
    await deps.settle();
    candidates = findPolicyCandidates(doc, pageUrl);
  }
  let links: PolicyLink[] = capPolicies(candidates);
  const prefetched = new Map<string, FetchedPage>();
  if (!links.length) {
    const wk = await findWellKnown(pageUrl, async (u) => asPage(await fetchHtml(u, pageUrl), u)?.html);
    links = wk.map((w) => w.link);
    for (const w of wk) prefetched.set(w.link.url, { html: w.html, finalUrl: w.link.url });
  }
  const fetched = await Promise.all(
    links.map(async (l) => {
      const page = prefetched.get(l.url) ?? asPage(await fetchHtml(l.url, pageUrl).catch(() => undefined), l.url);
      const ex = page ? extractFromHtml(page.html) : { text: "", readable: false };
      // Unreadable policies go with empty text so the backend can report them as "unreadable".
      return { url: page?.finalUrl ?? l.url, kind: l.kind, text: ex.readable ? ex.text : "" };
    }),
  );
  // Two links can redirect to the same document: keep the first.
  const seen = new Set<string>();
  const policies = fetched.filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)));
  return buildAnalyzeRequest({
    pageUrl,
    pageType,
    linksFound: Math.max(candidates.length, links.length),
    policies,
  });
}
