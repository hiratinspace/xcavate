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
  pages/article-1.html, article-2.html, article-3.html   ← plain articles (classifier negatives)
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

## Judge demo room and coverage cases

`http://localhost:4000/` serves the local demo hub in `fixtures/demo/`. Its static CSS and JavaScript are allowlisted under `/demo/`; arbitrary filesystem paths are never served. `npm run demo` builds and runs both services in rules-only mock mode. The original directory is at `/fixtures`.

- `http://privacyonly.localhost:4000/checkout` links only a readable privacy policy. Expected `partial`, never green.
- `http://unreadable.localhost:4000/checkout` links `/terms`, which deliberately returns 404. Expected `unknown`, never green.

These have independent origins so cached healthy FairBox results do not leak into coverage tests. Existing planted policy text, golden fixtures and hostile SneakyTerms CSS are preserved. Checkout presentation styles are shared via `/demo/store.css`. The hub is not a checkout and should never trigger automatic analysis.
