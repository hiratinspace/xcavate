// Test helper for fixture HTML. Contract: fixtures/README.md
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

export const SITES = ["streamnest", "gadgetly", "fairbox", "sneakyterms", "shopapp"] as const;
export type Site = (typeof SITES)[number];

export const STORE_PORT = 4000;
export const LEGAL_PORT = 4001;

/** Policy pages per store (the files under fixtures/sites/<site>/). */
export const POLICY_PAGES: Record<Site, readonly string[]> = {
  streamnest: ["subscription", "subscription.v2", "terms", "terms.v2", "privacy"],
  gadgetly: ["returns", "terms", "privacy"],
  fairbox: ["refunds", "terms", "privacy"],
  sneakyterms: ["terms", "terms-quoted", "privacy"],
  shopapp: ["terms"],
};

export const ARTICLES = ["article-1", "article-2", "article-3", "article-4"] as const;

/**
 * Direction v3: pages under fixtures/pages/ that copy the structure of real plan, sign-up and cart
 * pages (no real text). `url` is the address the pattern lives at on a real site, used by tests
 * because the classifier reads the path; `pageType` is what the classifier must say.
 * `plans-hydrated` renders its pricing table 1.5 s after load (a client-rendered page).
 */
export const PATTERN_PAGES = {
  "plans-saas": { url: "https://notely.example/pricing", pageType: "signup" },
  "trial-stream": { url: "https://streamly.example/premium", pageType: "signup" },
  "signup-steps": { url: "https://flickbox.example/signup/planform", pageType: "signup" },
  "plans-hydrated": { url: "https://boxly.example/plans", pageType: "signup" },
  "cart-empty": { url: "https://beanhouse.example/cart", pageType: "none" },
  "docs-1": { url: "https://widgetkit.example/docs/fetching-data", pageType: "none" },
  "article-4": { url: "https://ledger.example/2026/11/streaming-prices", pageType: "none" },
} as const;

/** Pages whose canonical URL is on the cross-origin legal host (port 4001). */
const LEGAL_HOSTED: Partial<Record<Site, readonly string[]>> = { streamnest: ["terms"] };

/**
 * Accepts loadFixture("gadgetly", "checkout"), loadFixture("gadgetly") (index),
 * loadFixture("pages", "article-1") and loadFixture("pages/article-1").
 */
function resolve(site: string, page?: string): { dir: string; page: string } {
  if (site.startsWith("pages/")) return { dir: "pages", page: site.slice("pages/".length) };
  if (site === "pages") return { dir: "pages", page: page ?? "article-1" };
  return { dir: `sites/${site}`, page: page ?? "index" };
}

export function fixturePath(site: Site | "pages" | `pages/${string}`, page?: string): string {
  const r = resolve(site, page);
  return join(FIXTURES_DIR, r.dir, `${r.page.replace(/\.html$/, "")}.html`);
}

/** Raw HTML of a fixture page. page defaults to "index" (the product page). */
export function loadFixture(site: Site | "pages" | `pages/${string}`, page?: string): string {
  return readFileSync(fixturePath(site, page), "utf8");
}

/**
 * The URL a fixture is served at by `npm run dev:fixtures`:
 * http://<site>.localhost:4000/<page> (index → "/"); StreamNest terms → http://legal.localhost:4001/streamnest/terms;
 * articles → http://pages.localhost:4000/<article> (also at http://localhost:4000/pages/<article>).
 */
export function fixtureUrl(site: Site | "pages" | `pages/${string}`, page?: string): string {
  const r = resolve(site, page);
  const p = r.page.replace(/\.html$/, "");
  if (r.dir === "pages") return `http://pages.localhost:${STORE_PORT}/${p}`;
  const s = site as Site;
  if (LEGAL_HOSTED[s]?.includes(p)) return `http://legal.localhost:${LEGAL_PORT}/${s}/${p}`;
  return `http://${s}.localhost:${STORE_PORT}/${p === "index" ? "" : p}`;
}
