import { MSG, stripPageUrl, type AnalyzeRequest, type FetchHtmlReply, type PageType } from "@xcavate/shared/core";
import { fetchCapped } from "../lib/fetchCapped";
import { send } from "../lib/messaging";
import { buildAnalyzeRequest } from "../lib/request";
import { extractFromHtml } from "./extractor";
import { capPolicies, findPolicyCandidates, findWellKnown, type PolicyLink } from "./policyFinder";

export interface FetchedPage {
  html: string;
  /** URL after redirects. Stripped of query + hash before it is sent or shown. */
  finalUrl: string;
}

async function viaServiceWorker(url: string): Promise<FetchedPage | undefined> {
  const r = await send<FetchHtmlReply>({ type: MSG.FETCH_HTML, url });
  return r?.ok && r.html !== undefined ? { html: r.html, finalUrl: r.finalUrl || url } : undefined;
}

/**
 * Fetch a policy page: same origin directly, other origins through the service worker (which
 * applies the SSRF guard). A same-origin URL that redirects to another origin fails in the content
 * script (CORS), so it falls back to the service worker too.
 */
export async function fetchPolicyHtml(url: string, pageUrl: string): Promise<FetchedPage | undefined> {
  if (new URL(url).origin === new URL(pageUrl).origin) {
    const r = await fetchCapped(url);
    if (r.ok && r.html !== undefined) return { html: r.html, finalUrl: r.finalUrl || url };
    if (r.status !== undefined) return undefined; // a real HTTP answer (404, 500): don't retry
  }
  return viaServiceWorker(url);
}

/** Policy identity after a redirect: origin + path, no query/hash; the original URL if the target is odd. */
function identityOf(finalUrl: string | undefined, fallback: string): string {
  try {
    const u = new URL(finalUrl || fallback);
    if (u.protocol !== "http:" && u.protocol !== "https:") return stripPageUrl(fallback);
    return stripPageUrl(u.href);
  } catch {
    return stripPageUrl(fallback);
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
  /** Fetched pages by fetch URL, kept across runs on the same page (SPA re-runs refetch nothing). */
  cache?: Map<string, FetchedPage | undefined>;
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
  const rawFetch = deps.fetchHtml ?? fetchPolicyHtml;
  const cache = deps.cache;
  const fetchPage = async (url: string): Promise<FetchedPage | undefined> => {
    if (cache?.has(url)) return cache.get(url);
    const page = asPage(await rawFetch(url, pageUrl).catch(() => undefined), url);
    cache?.set(url, page);
    return page;
  };

  let candidates = findPolicyCandidates(doc, pageUrl);
  if (!candidates.length && deps.settle) {
    await deps.settle();
    candidates = findPolicyCandidates(doc, pageUrl);
  }
  let links: PolicyLink[] = capPolicies(candidates);
  if (!links.length) {
    const wk = await findWellKnown(pageUrl, async (u) => (await fetchPage(u))?.html);
    links = wk.map((w) => w.link);
  }
  const fetched = await Promise.all(
    links.map(async (l) => {
      const page = await fetchPage(l.fetchUrl ?? l.url);
      const ex = page ? extractFromHtml(page.html) : { text: "", readable: false };
      // Unreadable policies go with empty text so the backend can report them as "unreadable".
      return { url: identityOf(page?.finalUrl, l.url), kind: l.kind, text: ex.readable ? ex.text : "" };
    }),
  );
  // Two links can redirect to the same document: keep the first.
  const seen = new Set<string>();
  const policies = fetched.filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)));
  return buildAnalyzeRequest({
    // V-11: the backend only needs the site, not which page of it you are on.
    pageUrl: new URL(pageUrl).origin + "/",
    pageType,
    linksFound: Math.max(candidates.length, links.length),
    policies,
  });
}
