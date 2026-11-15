/**
 * Collects the third-party addresses a page loads (scripts that will run, frames, tracking pixels and
 * the resource timeline) as "host/path", without query strings. The service worker matches them
 * against known session recorders and ad pixels (lib/watchers.ts). Never reads cookies, page globals
 * or anything the shopper typed; never blocks or changes anything; nothing leaves the browser.
 */
const JS_TYPES = /^(module|(text|application)\/(java|ecma)script)?$/i;
const MAX_ADDRESSES = 300;

export function thirdPartyAddresses(doc: Document): string[] {
  const raw: string[] = [];
  doc.querySelectorAll("script[src]").forEach((s) => {
    // Consent managers park scripts as type="text/plain" until the shopper agrees: those don't run.
    if (JS_TYPES.test((s.getAttribute("type") ?? "").trim())) raw.push(s.getAttribute("src") ?? "");
  });
  doc.querySelectorAll("iframe[src],img[src][width='1'],img[src][height='1']").forEach((e) => raw.push(e.getAttribute("src") ?? ""));
  const perf = doc.defaultView?.performance;
  if (perf && typeof perf.getEntriesByType === "function") for (const e of perf.getEntriesByType("resource")) raw.push(e.name);
  const base = doc.location?.href;
  const own = doc.location?.hostname ?? "";
  const out = new Set<string>();
  for (const a of raw) {
    try {
      const u = new URL(a, base);
      if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname !== own) out.add(u.hostname + u.pathname.slice(0, 40));
    } catch {
      /* not an address */
    }
    if (out.size >= MAX_ADDRESSES) break;
  }
  return [...out];
}

/**
 * Trackers often load a few seconds after the page: look again at 2.5 s, 6 s and 15 s and report
 * when the list changed. The returned function cancels the remaining checks (navigation, new run).
 */
export function watchAddresses(doc: Document, onChange: (addresses: string[]) => void): () => void {
  let key = thirdPartyAddresses(doc).join();
  const timers = [2500, 6000, 15000].map((ms) =>
    setTimeout(() => {
      const list = thirdPartyAddresses(doc);
      if (list.join() !== key) {
        key = list.join();
        onChange(list);
      }
    }, ms),
  );
  return () => timers.forEach(clearTimeout);
}
