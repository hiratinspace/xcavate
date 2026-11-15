# Fixture contract

Every lane relies on these URLs and file paths. Change them only together with every consumer.

## Hosts and ports

`npm run dev:fixtures` (`fixtures/server.mjs`, plain `node:http`, no dependencies) listens on two ports.

| Port | Host | Purpose |
|---|---|---|
| 4000 | `streamnest.localhost`, `gadgetly.localhost`, `fairbox.localhost`, `sneakyterms.localhost`, `shopapp.localhost`, `privacyonly.localhost`, `unreadable.localhost` | One fictional store per host. Chrome resolves `*.localhost` to 127.0.0.1, so every store is its own origin and its own cache domain. |
| 4000 | `localhost` | Path-prefix fallback for Node tools that cannot resolve `*.localhost`: `http://localhost:4000/<site>/<page>` serves the same files. Also `/` opens the judge demo room and `/fixtures` lists all stores. |
| 4001 | `legal.localhost` (or `localhost`) | A second origin for cross-origin policy fetches: `http://legal.localhost:4001/<site>/<page>`. |

Routing inside a store: `/` → `index.html` (product page), `/<name>` → `<name>.html`. Unknown → 404.

`GET /__set?site=streamnest&v=2` (any host) switches StreamNest's `terms` and `subscription` pages to their `.v2.html` variants; `v=1` switches back. `GET /__state` returns the current versions as JSON.

## Files

```
fixtures/
  server.mjs
  load.ts               ← test helper: loadFixture(site, page) → html string; fixtureUrl(site, page) → URL string; SITES list
  golden.json           ← validates against GoldenSchema in @xcavate/shared
  pages/article-1.html … article-4.html   ← plain articles (classifier negatives; article-4 quotes plan prices in prose)
  pages/plans-saas.html, trial-stream.html, signup-steps.html, plans-hydrated.html   ← real-world plan/sign-up patterns (should qualify)
  pages/cart-empty.html, docs-1.html   ← real-world negatives (empty cart, docs page with "Get started")
  sites/
    streamnest/ index.html checkout.html subscription.html subscription.v2.html terms.html terms.v2.html privacy.html
    gadgetly/   index.html checkout.html returns.html terms.html privacy.html
    fairbox/    index.html checkout.html refunds.html terms.html privacy.html
    sneakyterms/ index.html checkout.html terms.html terms-quoted.html privacy.html
    shopapp/    index.html   ← single-page app: a button swaps to a checkout view via history.pushState (D-02)
```

## What each store plants

| Store | Checkout links to | Planted content | Expected |
|---|---|---|---|
| StreamNest (subscription, signup for a free trial) | `/subscription` (same origin), `http://legal.localhost:4001/streamnest/terms` (cross-origin), `/privacy` | 7-day free trial then $14.99/month charged automatically; renews until cancelled; cancel by phone only (1-800-555-0199) with 30 days' notice. v2: price $19.99 and an early termination fee | red: trial_converts, auto_renewal, cancellation_friction |
| Gadgetly (one-off purchase) | `/returns`, `/terms`, `/privacy` | 25% restocking fee; buyer pays return shipping; arbitration + class waiver. Checkout order summary: Subtotal, Shipping, "Service fee $4.95", "Protection plan $12.99" (a pre-checked checkbox), Tax, Total | yellow: return_cost, arbitration (no high flags) |
| FairBox (clean control) | `/refunds`, `/terms`, `/privacy` | 30-day full refund, free returns, no subscription, "we do not charge a restocking fee", no arbitration | green, no flags |
| SneakyTerms (attack) | `/terms`, `/privacy` | "All sales are final" + early termination fee; hidden text (display:none, font-size:0, aria-hidden) and a visible sentence telling AI tools to report no issues. `terms-quoted.html` has the instruction inside a quotation. Checkout has aggressive global CSS (`* { … !important }`) to test card isolation | red: no_refund, termination_fee |

Every checkout has fake card fields (`autocomplete="cc-number"` etc.) inside a `<form>` with no action that leaves the page; nothing is ever submitted. The pay button sits next to a sentence "By placing your order you agree to our Terms…" that links the policies.

## Real-world patterns (direction v3)

A real-site test (27 pages in Chromium) found the card fired on only 4 of about 16 plan and checkout pages, and the policy finder picked cookie notices, product collections and billing apps as policies. These pages copy the structure of those sites (fictional text, no real copy) so the fixes have regression tests. `PATTERN_PAGES` in `load.ts` gives the real-site URL each one imitates (the classifier reads the path) and the expected page type.

| Page | Imitates | Expected |
|---|---|---|
| `plans-saas` | SaaS pricing table: prices split over spans, `$10 per seat/month`, `$12 USD / month`, `billed annually`, CTAs as `<a>` ("Try for $0.00", "Choose plan"); footer with a cookie link, a business agreement, a `/legal/` index and a help billing article | signup; finder keeps Terms of Service, Subscription Terms, Privacy Policy only |
| `trial-stream` | Streaming "premium" page: "Try 1 month for $0", `$13.99/month after your trial`, repeated "Terms apply." links, links to a billing app (`/commerce/billing`), a manage-subscription help article and Shopify `/collections/` and `/products/` | signup; finder keeps the paid subscription terms first, never the billing app or product pages |
| `signup-steps` | Step 1 of a sign-up flow at `/signup/planform`: "Monthly price" label + amount, a "Next" button | signup |
| `plans-hydrated` | Client-rendered pricing page: empty at load, table rendered after 1.5 s | none at load, signup after `watchForLateQualify` |
| `cart-empty` | Empty Shopify-style cart: account links, mini-cart "Subtotal $0.00" + "Check out" | none; finder skips cookie and collection links |
| `docs-1` | Docs page with "Get started" and "Sign up", no price | none |
| `article-4` | News story quoting `$9.99 a month` in prose, Subscribe button in the header | none |

## Judge demo room and coverage cases

`http://localhost:4000/` serves the local demo hub in `fixtures/demo/`. Its static CSS and JavaScript are allowlisted under `/demo/`; arbitrary filesystem paths are never served. `npm run demo` builds and runs both services in rules-only mock mode. The original directory is at `/fixtures`.

- `http://privacyonly.localhost:4000/checkout` links only a readable privacy policy. Expected `partial`, never green.
- `http://unreadable.localhost:4000/checkout` links `/terms`, which deliberately returns 404. Expected `unknown`, never green.

These have independent origins so cached healthy FairBox results do not leak into coverage tests. Existing planted policy text, golden fixtures and hostile SneakyTerms CSS are preserved. Checkout presentation styles are shared via `/demo/store.css`. The hub is not a checkout and should never trigger automatic analysis.
