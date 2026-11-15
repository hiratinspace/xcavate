/**
 * SSRF guard. A shop page must not be able to make the extension fetch (and forward to the backend)
 * pages on the shopper's own network: loopback, private, link-local and .local/.internal hosts.
 * A page that is itself on such a host (the fixture stores on *.localhost) may still reach them.
 */

function ipv4Parts(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : undefined;
}

function isPrivateV4([a, b]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Expand an IPv6 literal (already lower-case, no brackets) to 8 numbers, or undefined if malformed. */
function ipv6Groups(h: string): number[] | undefined {
  let s = h.split("%")[0];
  // A trailing dotted IPv4 ("::ffff:1.2.3.4") becomes two hex groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const p = ipv4Parts(dotted[1]);
    if (!p) return undefined;
    s = s.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part ? part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const g = [...head, ...new Array(fill).fill(0), ...tail];
  return g.length === 8 && g.every((n) => Number.isInteger(n)) ? g : undefined;
}

const v4Of = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

function isPrivateV6(h: string): boolean {
  const g = ipv6Groups(h);
  if (!g) return true; // unparseable literal: refuse
  const zero = (from: number, to: number) => g.slice(from, to).every((n) => n === 0);
  if (zero(0, 8)) return true; // ::
  if (zero(0, 7) && g[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d: judge the embedded IPv4.
  if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return isPrivateV4(v4Of(g[6], g[7]));
  // NAT64: 64:ff9b::/96 (well-known) and 64:ff9b:1::/48 (local use) carry an IPv4 in the low 32 bits.
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateV4(v4Of(g[6], g[7])) || g[2] === 1;
  // 6to4 2002:aabb:ccdd::/48 carries an IPv4 in groups 1-2.
  if (g[0] === 0x2002) return isPrivateV4(v4Of(g[1], g[2]));
  return (
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 old site-local
    (g[0] & 0xff00) === 0xff00 // multicast
  );
}

/**
 * Wildcard-DNS services that resolve a name to the IP written inside it (192.168.1.1.nip.io,
 * 10-0-0-1.sslip.io, c0a80101.nip.io) or always to loopback (lvh.me, localtest.me). No real shop
 * lives there, so they are treated as internal outright.
 */
const IP_IN_NAME_DOMAINS = ["nip.io", "sslip.io", "xip.io", "traefik.me", "local.gd", "localtest.me", "lvh.me", "vcap.me", "lacolhost.com"];

/** Any private/loopback IPv4 spelled in the labels: dotted across four labels, or dashed inside one. */
function embedsPrivateV4(h: string): boolean {
  const labels = h.split(".");
  for (let i = 0; i + 4 <= labels.length; i++) {
    const p = ipv4Parts(labels.slice(i, i + 4).join("."));
    if (p && isPrivateV4(p)) return true;
  }
  for (const label of labels) {
    for (const m of label.matchAll(/(?:^|[^\d])(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(?=$|[^\d])/g)) {
      const p = ipv4Parts(m.slice(1, 5).join("."));
      if (p && isPrivateV4(p)) return true;
    }
  }
  return false;
}

/** Normalise numeric IPv4 spellings (3232235777, 0xC0A80101, 0300.0250.1.1, 127.1) the way URL does. */
function canonicalHost(h: string): string {
  if (!/^[0-9a-fx.]+$/i.test(h)) return h;
  try {
    return new URL("http://" + h + "/").hostname;
  } catch {
    return h;
  }
}

/** True for loopback, private, link-local, unspecified, *.localhost, *.local and *.internal hosts. */
export function isInternalHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) return isPrivateV6(h.slice(1, -1));
  if (h.includes(":")) return isPrivateV6(h);
  h = canonicalHost(h);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".intranet") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (IP_IN_NAME_DOMAINS.some((d) => h === d || h.endsWith("." + d))) return true;
  const v4 = ipv4Parts(h);
  if (v4) return isPrivateV4(v4);
  if (!h.includes(".")) return true; // single-label names ("router", "intranet") resolve on the local network
  return embedsPrivateV4(h);
}

/**
 * Is the PAGE genuinely on the local network? Stricter than isInternalHost: name heuristics
 * (wildcard-DNS domains like nip.io, IPs spelled inside labels) only ever make a TARGET stricter.
 * They must never make a page trusted, because anyone can register a public name such as
 * printer-192-168-1-1.example.com. Only literal private/loopback IPs and names that cannot resolve
 * through public DNS (localhost, *.localhost, .local, .internal, .intranet, .lan, .home.arpa,
 * single-label names) count.
 */
export function isTrustedLocalPage(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) return isPrivateV6(h.slice(1, -1));
  if (h.includes(":")) return isPrivateV6(h);
  h = canonicalHost(h);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".intranet") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  const v4 = ipv4Parts(h);
  if (v4) return isPrivateV4(v4);
  return !h.includes(".");
}

/**
 * May a page at `pageUrl` make the extension fetch `targetUrl`? http(s) only; internal targets only
 * when the page itself is internal.
 */
export function isFetchAllowed(targetUrl: string, pageUrl: string | undefined): boolean {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (!isInternalHost(target.hostname)) return true;
  if (!pageUrl) return false;
  try {
    const page = new URL(pageUrl);
    return (page.protocol === "http:" || page.protocol === "https:") && isTrustedLocalPage(page.hostname);
  } catch {
    return false;
  }
}
