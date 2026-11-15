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

function isPrivateV6(h: string): boolean {
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d is normalised by URL to ::ffff:xxxx:yyyy).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mappedDotted) {
    const p = ipv4Parts(mappedDotted[1]);
    return !!p && isPrivateV4(p);
  }
  const first = parseInt(h.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 /* fc00::/7 */ || (first & 0xffc0) === 0xfe80 /* fe80::/10 */;
}

/** True for loopback, private, link-local, unspecified, *.localhost, *.local and *.internal hosts. */
export function isInternalHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) return isPrivateV6(h.slice(1, -1));
  if (h.includes(":")) return isPrivateV6(h);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".intranet") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  const v4 = ipv4Parts(h);
  if (v4) return isPrivateV4(v4);
  if (!h.includes(".")) return true; // single-label names ("router", "intranet") resolve on the local network
  return false;
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
    return (page.protocol === "http:" || page.protocol === "https:") && isInternalHost(page.hostname);
  } catch {
    return false;
  }
}
