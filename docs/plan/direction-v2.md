# Xcavate: weaknesses and direction v2

Written 2026-11-14 after the full P0 build. Sources: an outside adversarial critique (`docs/research/critique-external.md`, with competitor research), two independent code reviews (backend, extension), the real-site research (`docs/research/real-site-notes.md`), and the lead's own build notes.

## The one-paragraph diagnosis

What we built works on the stores we built. It has never been measured with the real model, never been run in a real Chrome profile, and its verdict is miscalibrated in both directions: every ordinary subscription goes red (cry wolf), and a site whose terms failed to load can go green (false comfort). Meanwhile "AI reads the terms and shows a traffic light" already exists (TermAlert, AgreeGuard, TermsDigest, Gemini in Chrome). Our defensible wedge is narrower and stronger than our pitch says: **every warning is a verified sentence, and at a free-trial sign-up it turns that sentence into a date, a dollar amount and an action.**

## Weaknesses, ranked

### Critical (fix before anything else)

| # | Weakness | Evidence | Direction |
|---|---|---|---|
| C1 | **No real AI has been measured.** Every number comes from mock mode, where the "model" is the rules engine. Real-world labels are AI-drafted and the rules were tuned on them. | `eval/results.md`, `server/src/llm/mock.ts` | Run the eval with the real model; human-review the 10 labels; report rules-only vs rules+Claude side by side. That comparison is the "why AI" slide. Mock mode must report `usedLlm:false`. |
| C2 | **Red means nothing.** Netflix, Spotify, Hulu, HelloFresh are all red, because plain auto-renewal is "high" unless the terms promise a reminder (almost none do). | real-world eval table; rubric 6.5 | Recalibrate: ordinary monthly renewal with online cancel = low (context, "normal for subscriptions"). Red only for harsh terms: phone/mail-only cancel, notice ≥ 30 days, termination fee, trial that converts to annual or with no reminder, no refunds on prepaid annual. |
| C3 | **Green can be false comfort.** Green whenever any one policy was analysed, even if only the privacy page loaded. | `server/src/pipeline/score.ts:28` | Green requires a terms, refund or subscription document to be analysed. Otherwise a grey "Partly read" state that names what could not be read. |
| C4 | **Never run end to end in a real browser.** All extension checks are jsdom + headless screenshots; the agent could not load the unpacked extension. | extension build report | A human runs the smoke checklist in a fresh Chrome profile today; automate with Playwright + Chromium (supports `--load-extension`) if time allows. |
| C5 | **The demo proves only that regex finds sentences we planted.** Injection beat is trivially true without the model. | demo script | Add one live real-site beat (Spotify Premium) and run SneakyTerms with the real model, or say "rules-only" honestly. |

### Major

| # | Weakness | Direction |
|---|---|---|
| M1 | **Pitch leads with homework** ("3 things to read before you pay"). The painkiller moment is the free-trial sign-up. | On trial pages the card headline becomes the charge: "Free for 7 days, then $14.99/mo from Nov 21", with **Remind me** on the card itself, plus one quoted line on the card. |
| M2 | **Differentiation table is a straw man** (only ToS;DR). | Rewrite against TermAlert / AgreeGuard / Gemini: proof (verified quote, can't invent a warning) + action (date, reminder, cancel path) + local fee/add-on checks. |
| M3 | **Slow at the decision moment** (up to 10 s fetch + 12 s LLM + retry). | The rules engine is pure TS with no Node deps: run it **in the extension** for an instant, private, offline first verdict; the backend LLM pass upgrades it when it arrives. Also a stronger privacy story: "nothing leaves your browser unless you want the AI check". |
| M4 | **Fires too late.** Trial terms live on plans/pricing pages, before card entry. | Classifier also fires on plan pages with "Start free trial / Try free" CTAs plus a price. |
| M5 | **Judges can't try it.** Local-only backend, load-unpacked only. The "shared cache" claim is false (seed-only after the poisoning fix). | Deploy the backend, ship a packed .zip; drop or fix the shared-cache claim (a server-side fetch of policy URLs would make shared results trustworthy). |
| M6 | **Money-first is diluted.** Arbitration and data sharing push sites to yellow. | Keep them in the popup only, out of the card's top 3 and out of the verdict. |
| M7 | **Change alerts duplicate competitors** and only fire on a second visit to a checkout, which rarely happens. | Keep the code, cut it from the pitch. |
| M8 | **Server learns your checkout history** (origin + path). | Send the domain only where the path isn't needed; say plainly what the server sees. |
| M9 | **Correctness bugs found by review** (being fixed now): false "phone only" when online cancel exists, trial denial flagged, unverified LLM free text (invented phone numbers), intranet fetch via policy links, query strings in policy URLs, classifier false positives on news pages, user's own ticks flagged as pre-checked. | Fix rounds in progress for backend and extension. |

### Minor

- Long tail untested: Shopify stores use `/policies/refund-policy` and `/policies/terms-of-service`; add them to fallback paths.
- Content script is ~95 KB on every page (zod in the shared barrel); being split.
- `<all_urls>` install friction: name per-site optional permissions in the roadmap.
- Fee detector untested on real checkouts (iframes, hosted checkout pages).
- Plan item "hackathon rule check" (code before the event?) is still open.

## Missed opportunities (highest value per hour)

1. **Charge-date headline + Remind me on the card** (S, high).
2. **Verdict recalibration + "Partly read" state** (S, high).
3. **Real model measured on human-reviewed real policies, rules vs rules+Claude** (M, high).
4. **"Your rights" line on cancellation friction**: California's auto-renewal law (AB 2863, from 2025-07-01) requires online cancellation for online sign-ups; the federal click-to-cancel rule was vacated in July 2025. Information, never advice. (M, medium-high; unique.)
5. **In-browser rules engine for an instant private first verdict** (M, high for speed and privacy).
6. **Deploy + .zip so judges can try it on a store of their choice** (S-M, medium).

## New pitch line

"Xcavate is the terms checker that can't make up a warning. Every flag is a sentence from the site's own terms, and when you start a free trial it tells you the date and amount you'll be charged and sets the reminder."
