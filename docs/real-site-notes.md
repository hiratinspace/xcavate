# Real-site notes (Q-05 prep)

Local only. Researched 2026-11-14 by an AI research agent; a human must re-check before anything is shown on stage.

## How this was tested

- Each policy URL was fetched with plain `curl -L` (desktop Chrome User-Agent, no cookies, no JavaScript), then run through a Python copy of the BUILD_PLAN 7.3 extractor (drop `script, style, noscript, svg, nav, header, footer, form, iframe` and hidden elements, blank line between blocks, collapse spaces).
- "Server-rendered" = extracted text is at least 500 chars of real policy text. "JS-rendered" = under 500 chars, so the extension would need the "Scan this page" fallback.
- Blocking was judged from the HTTP status and page body (Akamai "Access Denied", Cloudflare "Just a moment...", Incapsula resource stub).
- Caveat: `curl` has a non-browser TLS fingerprint. Several 403s/timeouts below come from bot managers that often let a real Chrome `fetch` through (the extension's service worker uses the browser's network stack). Treat "blocked" as "blocked for a server-side fetch; untested from the extension". The classifier and finder were not run in a real browser.
- No account was created, nothing was submitted, no personal data was sent. Only public pages were fetched.

## Site table

| # | Site (type) | Sign-up / checkout entry | Policy links seen (text -> href) | Policy page fetch | Verdict for us |
|---|---|---|---|---|---|
| 1 | Netflix (streaming) | `https://www.netflix.com/signup` (200, reachable without login; the page itself is JS-rendered, 146 chars of static text) | Footer: "Terms of Use" -> `https://help.netflix.com/legal/termsofuse`; "Privacy" -> `https://help.netflix.com/legal/privacy` | Terms of Use: server-rendered, ~56k chars | Good |
| 2 | Spotify Premium (music subscription, free trial) | `https://www.spotify.com/us/premium/` (200; plan cards with trial CTAs) | Next to plan cards: "Terms apply." -> `https://www.spotify.com/us/legal/paid-subscription-terms/` (also `/us/legal/paid-subscription-terms/?ref=premium`); footer "Legal" -> `/us/legal/`, "Privacy Policy" -> `/us/legal/privacy-policy/` | Paid Subscription Terms: server-rendered, ~30k chars. End User Agreement also server-rendered (~55k) | Good (best trial demo) |
| 3 | Hulu / Disney+ (streaming bundle, free trial) | `https://www.hulu.com/welcome` (200); CTAs go to `/commerce/billing?...` (needs account creation first). `https://www.disneyplus.com/` same pattern | Hulu: "Hulu Subscriber Agreement" -> `/terms`; "Terms of Use" -> `https://www.hulu.com/subscriber_agreement`; "Disney+ Subscriber Agreement" -> `https://www.disneyplus.com/legal/subscriber-agreement`. Many "Terms apply" links are `#modal-...` anchors or empty hrefs | `hulu.com/subscriber_agreement`: server-rendered, ~58k chars (same combined Disney+/ESPN/Hulu agreement). `disneyplus.com/legal/subscriber-agreement`: JS-rendered (5 chars) | Good via the Hulu URL; Disney+ URL needs fallback |
| 4 | HelloFresh (meal-kit subscription) | `https://www.hellofresh.com/plans` (200, JS-rendered, 244 chars static) | Footer: "Terms and Conditions" -> `/about/termsandconditions`; "Privacy" -> `/about/privacy` | Terms: server-rendered, ~109k chars (largest document seen) | Good |
| 5 | Planet Fitness / gyms (membership) | `https://www.planetfitness.com/` 403 Cloudflare challenge ("Just a moment..."). Also tried: Anytime Fitness (Incapsula stub, 0 chars), Crunch (JS, 0 chars), 24 Hour Fitness (208 chars), LA Fitness (see notes) | Planet Fitness: not reachable. LA Fitness footer: "Terms & Conditions" -> `/Pages/TermsAndConditions.aspx`, "Privacy Policy" -> `/Pages/PrivacyPolicy.aspx` | LA Fitness terms: 0 chars with the 7.3 rules, ~18k chars if `<form>` is kept (ASP.NET bug, see below). Gym money terms live in the in-club membership agreement, which is not public | Poor; avoid gyms in demo |
| 6 | Ticketmaster (ticketing, fees) | `https://www.ticketmaster.com/` (200); event checkout needs an event and a login | Footer: "terms of use" -> `https://legal.ticketmaster.com/terms-of-use`; "Our Policies" -> `https://legal.ticketmaster.com`; "Privacy Policy" -> `https://privacy.ticketmaster.com/privacy-policy` | `legal.ticketmaster.com/terms-of-use/` 93 chars, `/purchase-policy/` 106 chars: JS-rendered. Help-centre "Purchase Policy" article just links out (532 chars of help-centre chrome, no policy text). SeatGeek `/terms` 403 | Needs "Scan this page" fallback |
| 7 | Zappos (one-off retailer) | Checkout needs a cart; footer on every page | Footer: "Shipping And Returns Policy" -> `/c/shipping-and-returns`; "Terms of Use" -> `/terms-of-use`; "Privacy Policy" -> `/c/privacy-policy` | Shipping and Returns: server-rendered, ~3.4k chars | Good |
| 8 | IKEA US (generous refund) | Checkout needs a cart | Return-policy pages link "Return Policy" -> `https://www.ikea.com/us/en/customer-service/returns-claims/` | Server-rendered, ~2.4k chars of policy | Good (green check) |

Also checked (short):

| Site | Result |
|---|---|
| The New York Times | `nytimes.com/subscription` JS-rendered (36 chars, a CAPTCHA script is present). Terms of Service at `https://help.nytimes.com/policies/115014893428-Terms-of-Service` server-rendered, ~58k chars |
| Brooklinen (retailer, 365-day returns) | `https://www.brooklinen.com/pages/returns` server-rendered, ~530 chars of policy (just over the 500 threshold) |
| 37signals / Basecamp (SaaS) | `basecamp.com/about/policies/refund` redirects to `https://37signals.com/policies/refund`, server-rendered, ~4.4k chars; terms ~13.5k |
| Adobe | Plans and subscription terms: 403 Akamai "Access Denied" |
| Best Buy, REI | Connection timed out (typical bot-manager behaviour for non-browser clients) |
| L.L.Bean, Lands' End, Lowe's, Home Depot, Lululemon, Uniqlo, Crate and Barrel, B&H, Warby Parker | 403 or block page |
| Patagonia `/returns.html` | Served a "System maintenance" page to curl (likely a block page) |
| Costco customer service | 401 |
| Nordstrom, Apple returns, StubHub legal | 200 but 0 chars (JS-rendered) |
| Allbirds `/pages/returns-exchanges` | 200 but returns text not in static HTML |
| Target returns hub | 1.9k chars, but it is only a list of question links (not policy text) |

## What the terms state (neutral wording, for reference)

- Netflix Terms of Use state the subscription "will continue and automatically renew until terminated", that "Payments are nonrefundable", that prices can change with at least one month's notice, and that most disputes go to arbitration (with an opt-out window). Cancellation is self-serve from the Account page.
- Spotify Paid Subscription Terms state that for some trials, by providing payment details "we may automatically begin charging you ... on the first day following the end of the Trial", and that paid subscriptions continue until cancelled. Cancellation is self-serve.
- The Disney+/ESPN/Hulu Subscriber Agreement states the first payment is charged immediately after a free trial, that there is no separate notice before a trial ends (unless law requires), that partially used terms are not refunded, that pricing can change with attempted advance email notice, and that disputes go to individual arbitration.
- HelloFresh Terms state weekly auto-renewal, that "the Service subscription fee shall be non-refundable", that prices can change with at least 10 days' notice for the plan rate, that order changes lock five days before delivery, and that disputes go to individual arbitration. Cancellation is possible online.
- Zappos states free shipping and free returns within 60 days; final-sale items are excluded and non-compliant returns could incur a restocking fee up to 50%.
- IKEA states 365 days for new unopened products and 180 days for opened products, full refund to the original payment method, with a few named exclusions.
- Brooklinen states most products can be returned within 365 days, and all returns carry a $9.95 return fee.

## Findings for the extension builders (D-03, D-04)

1. **`form` removal can wipe whole pages.** ASP.NET WebForms sites (LA Fitness) wrap the entire `<body>` in `<form id="aspnetForm">`. The 7.3 rule "remove `form`" then returns 0 chars. Suggested fix: only remove forms that contain `input`/`select`/`textarea` other than hidden inputs, or skip removal when the form contains most of the page text. Not changed here (other agents own `extension/`).
2. **"Terms apply" links often point to in-page modals** (`#modal-...` on disneyplus.com) or have an empty `href` (hulu.com/welcome). After "de-duplicate by URL without hash" these collapse to the current page. The finder should skip empty and hash-only hrefs, or treat a hash link as "scan this element".
3. **"Subscriber Agreement" does not match the link-text patterns** (`subscription|billing|...`, `terms|conditions|tos|user agreement|legal`). Hulu's "Hulu Subscriber Agreement" is only caught through its href (`/terms`). Consider adding `subscriber agreement` and `agreement` to the terms pattern.
4. **The entry pages themselves are mostly JS-rendered** (Netflix signup, HelloFresh plans, NYT subscription). That is fine for the classifier (it reads the live DOM), but it means footer links may only exist after hydration. The orchestrator should run the finder after the page settles (D-02 already watches DOM changes).
5. **Policy documents are long.** HelloFresh ~109k, Hulu ~58k, NYT ~58k, Netflix ~56k chars. All are under the 200k cap, but the prefilter (A-02) matters for latency and cost.
6. **Redirects:** Spotify's old promotional-offer-terms URL redirects to paid-subscription-terms; basecamp.com policies redirect to 37signals.com; NYT help article redirects to `/policies/...`. The extractor should store the final URL for "See in policy" links.

## Works best on…

Xcavate works best on large subscription and streaming services and mainstream retailers whose legal pages are classic server-rendered help or legal pages (Netflix, Spotify, Hulu, HelloFresh, Zappos, IKEA). It struggles with ticketing sites (Ticketmaster's legal site is a JavaScript app), gyms (membership terms are not online, and big chains sit behind Cloudflare/Incapsula), and retailers behind aggressive bot managers (Adobe, Best Buy, REI, Home Depot, Lowe's) when fetched outside a browser. For those, the "Scan this page" fallback is the path, and the pitch should say so.

## Recommended safe secondary demo checks

1. **Spotify Premium** (`https://www.spotify.com/us/premium/`): stable page, "Terms apply." link sits right next to the trial CTA, terms are server-rendered, and the trial-to-paid clause is explicit. Expected red (trial converts, auto-renewal). Matches the demo persona (student, free trial).
2. **Netflix sign-up** (`https://www.netflix.com/signup`): reachable without login, footer links to server-rendered Terms of Use; the auto-renewal and "Payments are nonrefundable" sentences are unambiguous. Expected red.
3. **IKEA US return policy** as the green counter-example: server-rendered, short, clearly generous. Caveat: it is a policy page, not a checkout page, so the demo needs a cart or a manual "Scan this page" to trigger the card. If a real checkout is needed for green, 37signals (Basecamp sign-up, generous refund policy) is the backup to verify.

Before stage: a human should open each page in Chrome with the extension, confirm the card, and read every quoted clause against the live page (Q-05 rule). Phrase everything as "the terms state…".

## Eval set

Saved texts and draft labels are in `eval/real/` (git-ignored, copyrighted). See `eval/real/labels.json`: 10 items (4 red, 3 yellow, 3 green). Labels were drafted by an AI agent and need human review before any numbers are quoted.
