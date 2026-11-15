/**
 * Normalise text for quote matching (section 7.4 step 5):
 * lower-case, straighten curly quotes and dashes, collapse whitespace.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[\s ​]+/g, " ")
    .trim()
    .toLowerCase();
}

/** Whitespace-only normalisation used before hashing policy text. */
export function normalizeForHash(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** sha256 hex using Web Crypto (available in Chrome and Node 20+). */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable flag id: category + ":" + first 8 hex of sha256(normalised quote) (section 6.1). */
export async function flagId(category: string, quote: string): Promise<string> {
  return category + ":" + (await sha256Hex(normalizeForMatch(quote))).slice(0, 8);
}

/** origin + path only; query string and hash removed (AnalyzeRequest.pageUrl). */
export function stripPageUrl(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}

/** Domain key used for caching: hostname without leading "www.", plus port when present. */
export function domainOf(url: string): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  return u.port ? host + ":" + u.port : host;
}

function encFragment(s: string): string {
  return encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");
}

/** "See in policy" link with a text fragment highlighting the quote (section 7.6). */
export function textFragmentUrl(policyUrl: string, quote: string): string {
  if (!policyUrl) return "";
  const base = policyUrl.split("#")[0];
  const words = quote.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return base;
  if (words.length <= 10) return base + "#:~:text=" + encFragment(words.join(" "));
  const start = words.slice(0, 6).join(" ");
  const end = words.slice(-4).join(" ");
  return base + "#:~:text=" + encFragment(start) + "," + encFragment(end);
}
