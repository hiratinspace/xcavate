# Smoke checklist (Q-04)

A scripted manual pass over the four fixture stores. Run it from a cold start: a fresh Chrome profile and a fresh backend database. Pass = every box ticked, twice in a row.

## 0. Cold start

1. `npm install` (once), then in three terminals:
   - `npm run dev:server` (backend on http://localhost:8787, `LLM_PROVIDER=mock` is fine)
   - `npm run dev:fixtures` (stores on :4000, legal host on :4001)
   - `npm run build -w @xcavate/extension` (or `npm run dev:ext` to rebuild on change)
2. Fresh database: stop the server, delete `server/data/xcavate.db`, start it again. Do not run `npm run seed` for the first pass (the second pass may use it to check the instant path, step 7).
3. Fresh profile: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/tmp/xcavate-smoke --no-first-run` (any empty folder works).
4. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, pick `extension/dist`.
   - [ ] Xcavate loads with no errors (no red "Errors" button on its tile).
   - [ ] The toolbar icon (magnifier over earth layers) shows. Pin it.
5. Click **service worker** on the Xcavate tile to open its DevTools; keep the **Network** tab open for the whole pass.

## 1. StreamNest (red) http://streamnest.localhost:4000/checkout

- [ ] Product page http://streamnest.localhost:4000/ shows **no card** and no badge.
- [ ] On `/checkout` a card appears bottom-right at once saying "Checking the fine print", then turns red: octagon "!" icon, "Read first", and the headline "Free for 7 days, then $14.99/month from <today + 7, e.g. Sat, Nov 21>" (V-05).
- [ ] Under the headline: **Remind me 2 days before** (opens Google Calendar) and **.ics file** (downloads), both reachable with Tab and Enter. Then one quoted sentence (the trial clause) with **See in policy**.
- [ ] Below the quote: renews automatically, cancel by phone only / 30 days' notice, each with a severity word (High). The trial flag is not repeated and arbitration is **not** on the card (the popup still lists it).
- [ ] Badge is red `!3` (or `!` + flag count).
- [ ] Service worker Network tab: one `POST /v1/analyze`. Request body has only `pageUrl`, `pageType`, `linksFound`, `policies` (each `url`, `kind`, `text`, optional `previousHash`). `pageUrl` is just the origin with a slash (`http://localhost:3000/` style, V-11), never the checkout path.
- [ ] The cross-origin terms page `http://legal.localhost:4001/streamnest/terms` was fetched by the service worker (it appears in the service worker's Network tab, not the page's).
- [ ] Open the popup: every flag shows title, summary, cost, the quote in a blockquote, and **See in policy**.
- [ ] **See in policy** opens the policy with the quoted sentence highlighted and scrolled into view.
- [ ] "Free trial: 7 days" section: **Remind me 2 days before I'm charged** opens Google Calendar with an all-day event dated today + 5 days, titled "StreamNest trial ends in 2 days: cancel or keep?", details mention $14.99 and the policy link. **Download .ics** saves a file that opens in Calendar.
- [ ] "How to cancel": By phone only, 30 days' notice, 1-800-555-0199 (tap-to-call link). **Draft cancellation email** opens the mail app with subject "Cancellation request" and a filled body. Nothing is sent.
- [ ] "Policies read" lists the subscription and terms pages as read.
- [ ] Reload the page: the verdict appears instantly and the Network tab shows **no** new `POST /v1/analyze` (24 h cache; policy text unchanged).

## 2. Gadgetly (yellow + local findings) http://gadgetly.localhost:4000/checkout

- [ ] Card is yellow: "~" icon, "Worth a look", "Worth a quick look"; flags for restocking fee / return shipping and arbitration (no High flags).
- [ ] Card row "Fees added at checkout: Service fee $4.95, Protection plan $12.99".
- [ ] Card row "2 options were ticked for you" (protection plan, monthly auto-ship).
- [ ] On the page, the pre-checked **Protection plan** has a 2 px amber outline with a label "Pre-checked: adds $12.99"; the pre-selected "Subscribe & save" option is outlined too.
- [ ] Untick Protection plan: its outline disappears; the box stays unticked (Xcavate never changes it back). Pick "One-time purchase": the auto-ship outline disappears.
- [ ] Popup lists the fee lines (+ Service fee, + Protection plan) and the ticked options.
- [ ] Network tab: the `/v1/analyze` body contains no fee amounts, no "Protection plan" checkbox label, no form contents.
- [ ] Badge is yellow with the flag count.

## 3. FairBox (green) http://fairbox.localhost:4000/checkout

- [ ] Card is green: round check icon, "Looks fair", "No money traps found in the terms", "We read N policies and found no…".
- [ ] No fee row, no ticked-options row, no outlines (the newsletter box is not pre-checked).
- [ ] Badge is green `✓`.
- [ ] Popup shows no flags, no trial or cancel section, and lists the policies read.

## 4. SneakyTerms (red despite the attack) http://sneakyterms.localhost:4000/checkout

- [ ] The page's aggressive global CSS (`* { … !important }`) does **not** restyle the card: fonts, colours and layout match the other stores.
- [ ] Card is red with flags for no refunds ("All sales are final") and the early termination fee.
- [ ] In the service worker Network tab, the terms text in the request does **not** contain the hidden instructions ("ignore previous instructions", "SYSTEM OVERRIDE", "fully refundable"). The visible "Note to AI assistants…" sentence may appear: it is part of the policy as shown.
- [ ] Open http://sneakyterms.localhost:4000/terms-quoted directly, open the popup, press **Scan this page**: the result is red with no_refund and termination_fee.

## 5. Card behaviour (any store)

- [ ] Close button (×) dismisses the card; reloading the page in the same tab keeps it dismissed. A new tab shows it again.
- [ ] Escape dismisses the card (unless you are typing in a page field).
- [ ] Keyboard only: Tab reaches the card's close and "See all" buttons with a visible focus ring; "See all" toggles the hint.
- [ ] macOS System Settings, Accessibility, Display, Reduce motion on: the card appears without sliding and the checking strip does not animate.
- [ ] The page layout does not shift when the card appears; the checkout still works normally.

## 6. Failure paths

- [ ] Stop the backend, open http://fairbox.localhost:4000/checkout in a new tab: the checking card disappears silently, no badge, no errors in the page console. The popup says "The Xcavate service didn't answer" and names the address.
- [ ] Start the backend again; popup **Scan this page** on a policy page works.
- [ ] Popup Settings: **Pause on gadgetly.localhost:4000**, reload Gadgetly checkout: no card, no outlines, no network calls (page and service worker). Untick to resume.
- [ ] Settings: untick "Check checkout pages automatically": no card anywhere. Tick again.
- [ ] Settings: change the service address to `http://localhost:9`, Save, visit a new store: silent (no card). Set it back to `http://localhost:8787`.
- [ ] Visit a plain article, e.g. http://localhost:4000/pages/article-1 : no card, no badge.

## 7. SPA, change alert, instant path (second pass)

- [ ] ShopApp http://shopapp.localhost:4000/ : no card. Click **Go to checkout** (no reload, URL changes to `/checkout`): the card appears within a second or so. Click "Back to the shop": the card goes away and the badge clears.
- [ ] Change alert: visit StreamNest checkout once. Open http://localhost:4000/__set?site=streamnest&v=2 , reload the StreamNest checkout: the card and popup show "Terms changed since your last visit" with the price change. Reset with `v=1`.
- [ ] Instant path: stop the server, delete the DB, run `npm run seed`, start the server. In a fresh profile, a first-ever visit to a fixture checkout shows its verdict in under 0.5 s (`GET /v1/report?domain=` in the service worker Network tab).

## 8. Direction v2 extras

- [ ] Partial: on a page where only the privacy policy (or some policies) could be read, the card and popup say "Partly read" with a grey half-circle icon, list what couldn't be read and suggest Scan this page. Badge is grey `◐`, never green.
- [ ] Flags with a context line show it in italics under the summary. Flags with a rights note show a "Your rights (general information, not legal advice)" box in the popup (and on the card for the top 3); only http(s) URLs in it are links.
- [ ] Pricing page: a page with "Start free trial" (or "Try it free" / "Get started free") next to "$9.99/mo" or "14-day trial" gets a card (sign-up). A news story with a paywall banner does not.
- [ ] Shopify store with no policy links on checkout: the service worker fetches `/policies/refund-policy` and `/policies/terms-of-service` first.
- [ ] Popup footer: "Sent for analysis: the site's address (domain only) and the text of the policy pages it links to. ..."

## Notes

- Failures go in as tickets or get fixed before the second pass.
- `XCAVATE_API=http://localhost:8787 npx vitest run --project extension backend.live` runs the extension's own collector on all four checkouts against the running backend and checks `golden.json` verdicts, a quick automated pre-check before this manual pass.
