/** fetch with a timeout and a byte cap. Used by the service worker (FETCH_HTML) and same-origin content fetches. */

export const FETCH_TIMEOUT_MS = 10_000;
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
  { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = FETCH_MAX_BYTES, fetchImpl = globalThis.fetch } = {},
): Promise<CappedResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "bad url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "only http(s)" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(parsed.href, {
      credentials: "omit",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
    });
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
