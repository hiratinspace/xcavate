import type { WatcherFinding } from "@xcavate/shared/core";

/**
 * "Watching this checkout": which vendors a page's third-party addresses belong to. Runs in the
 * service worker (the content script only collects addresses, to stay inside its 60 KB budget).
 * Nothing here leaves the browser.
 *
 * The list is deliberately short and conservative: vendors whose script on a page means recording
 * (session replay) or conversion tracking (ad pixel). Tag managers and general analytics are left
 * out because their presence alone says nothing about what they do.
 */
interface Rule {
  host: string;
  /** Only addresses whose path starts with this (for hosts that also serve unrelated files). */
  path?: string;
  vendor: string;
  kind: WatcherFinding["kind"];
}

/**
 * Compact table (the content script has a 60 KB budget): "kind|Vendor|host host/path ...", one per
 * line; r = session recorder, a = ad pixel.
 */
const TABLE = `r|Hotjar|hotjar.com hotjar.io
r|FullStory|fullstory.com
r|Microsoft Clarity|clarity.ms
r|LogRocket|logrocket.io logrocket.com lr-ingest.io lr-ingest.com
r|Mouseflow|mouseflow.com
r|Smartlook|smartlook.com smartlook.cloud
r|Lucky Orange|luckyorange.com luckyorange.net
r|Quantum Metric|quantummetric.com
r|Contentsquare|contentsquare.net
r|Glassbox|glassboxdigital.io
r|Inspectlet|inspectlet.com
r|Crazy Egg|crazyegg.com
a|Meta|connect.facebook.net facebook.com/tr
a|TikTok|analytics.tiktok.com
a|Google Ads|googleadservices.com googleads.g.doubleclick.net
a|Pinterest|ct.pinterest.com s.pinimg.com/ct
a|Snapchat|sc-static.net tr.snapchat.com
a|X (Twitter)|static.ads-twitter.com analytics.twitter.com
a|LinkedIn|snap.licdn.com px.ads.linkedin.com
a|Reddit|redditstatic.com/ads alb.reddit.com
a|Microsoft Ads|bat.bing.com
a|Criteo|criteo.com criteo.net
a|Amazon Ads|amazon-adsystem.com`;

export const WATCHER_RULES: Rule[] = TABLE.split("\n").flatMap((line) => {
  const [k, vendor, hosts] = line.split("|");
  const kind: WatcherFinding["kind"] = k === "r" ? "session_replay" : "ad_pixel";
  return hosts.split(" ").map((h) => {
    const i = h.indexOf("/");
    return i < 0 ? { host: h, vendor, kind } : { host: h.slice(0, i), path: h.slice(i), vendor, kind };
  });
});

const MAX_WATCHERS = 12;

/** The rule an address matches, if any. Exact host or a subdomain of it; never a lookalike. */
export function matchWatcher(address: string, base?: string): Rule | undefined {
  let u: URL;
  try {
    u = new URL(address, base);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  const host = u.hostname.toLowerCase();
  return WATCHER_RULES.find((r) => (host === r.host || host.endsWith("." + r.host)) && (!r.path || u.pathname.startsWith(r.path)));
}

/** Each vendor once, session recorders first, capped. */
export function matchWatchers(addresses: readonly string[]): WatcherFinding[] {
  const seen = new Map<string, WatcherFinding>();
  for (const a of addresses) {
    const r = typeof a === "string" ? matchWatcher(a.includes("://") ? a : "https://" + a) : undefined;
    if (r && !seen.has(r.vendor)) seen.set(r.vendor, { kind: r.kind, vendor: r.vendor });
  }
  return [...seen.values()]
    .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "session_replay" ? -1 : 1))
    .slice(0, MAX_WATCHERS);
}
