/** fetch with a timeout and a byte cap. Used by the service worker (FETCH_HTML) and same-origin content fetches. */

/**
 * Per attempt. A policy page that has not answered in 4 s is very likely stuck (a heavy retailer page);
 * the content script then tries once through the service worker, and the verdict is shown from
 * whatever arrived instead of waiting.
 */
export const FETCH_TIMEOUT_MS = 4_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;

export interface CappedResult {
  ok: boolean;
  status?: number;
  html?: string;
  finalUrl?: string;
  error?: string;
}

export async function fetchCapped(
  url: string,
  {
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = FETCH_MAX_BYTES,
    fetchImpl = globalThis.fetch,
    allow = (_u: string) => true,
  }: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch; allow?: (url: string) => boolean } = {},
): Promise<CappedResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "bad url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "only http(s)" };
  if (!allow(parsed.href)) return { ok: false, error: "blocked" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(parsed.href, {
      credentials: "omit",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
    });
    // Re-check where redirects led: a public URL must not bounce us into the local network.
    //
    // Accepted residual risk (security review, round 3): we keep redirect: "follow".
    // - In an MV3 service worker, redirect: "manual" gives an opaqueredirect response with no
    //   readable Location, so each hop cannot be checked before it is requested.
    // - Refusing all redirects would break many real policy links (http to https, /terms to
    //   /legal/terms, locale redirects, Shopify /policies/ paths).
    // - So a public URL that redirects to an internal one still causes one credential-less GET
    //   (credentials: "omit") to that address. Its response is discarded here and never read.
    // - DNS rebinding (a public name that later resolves to a private IP) cannot be stopped by
    //   hostname checks alone. Any text that did leak would only reach the Xcavate backend,
    //   which does not show client-submitted text to anyone else.
    if (res.url && !allow(res.url)) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, error: "blocked redirect" };
    }
    if (!res.ok) return { ok: false, status: res.status };
    const type = res.headers.get("content-type") ?? "";
    if (type && !/html|text\/plain|xml/i.test(type)) return { ok: false, status: res.status, error: "not html" };
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) return { ok: false, status: res.status, error: "too large" };
    const html = await readCapped(res, maxBytes);
    if (html === undefined) return { ok: false, status: res.status, error: "too large" };
    return { ok: true, status: res.status, html, finalUrl: res.url || parsed.href };
  } catch (e) {
    return { ok: false, error: ctrl.signal.aborted ? "timeout" : String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string | undefined> {
  if (!res.body || typeof res.body.getReader !== "function") {
    const t = await res.text();
    return t.length > maxBytes ? undefined : t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}
