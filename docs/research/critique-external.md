# Xcavate: external critique (judge + product critic view)

Written 2026-11-14. Adversarial by design. Based on BUILD_PLAN.md, README, docs/, eval/results.md, and a skim of extension/src and server/src.

## Executive summary

- **You have no measured AI.** `eval/results.md` runs `LLM_PROVIDER=mock`, and `server/src/llm/mock.ts` is the rules engine dressed up as a model. "LLM answered 10/10" and "0% dropped by quote verification" therefore mean nothing. The real-world labels were also drafted by AI and the rules were tuned on them. Right now no number can go on a slide. (critical)
- **Red has stopped meaning anything.** All 4 real subscription services (Netflix, Spotify, Hulu, HelloFresh) come back red, because ordinary auto-renewal plus arbitration is enough. Every subscription gets the same alarm, which is the "cry wolf" failure the plan says it forbids. (critical)
- **"At checkout, traffic light, AI reads the terms" is already on the market.** TermAlert, AgreeGuard and TermsDigest exist, and Gemini in Chrome can summarize any page for every US desktop user. The only defensible wedge is the verified quote plus an action (date-stamped reminder, cancel path), and the plan doesn't lead with it. (major)
- **Green can be false comfort.** The server returns green whenever at least one policy was analysed, even if it was only the privacy policy and the refund or terms pages failed to load. (major)
- **The demo proves only that regex finds sentences you planted yourself.** It runs on four fake stores, mock mode, and a local backend. The prompt-injection beat is trivially true in mock mode, because regex can't be prompt-injected. Show one real site with the real model, or a judge will say it for you. (critical)

---

## 1. Problem and value

**Vitamin for most purchases, painkiller for one moment** (major). On a one-off retail purchase nobody abandons a cart over arbitration or a 25% restocking fee. The card changes behaviour in one case: **free-trial and subscription sign-up**, where the action is "set a reminder / use a virtual card / pick monthly instead of annual". Everything else is nice to know.

**The most valuable moment is "You will be charged $14.99 on Nov 21 unless you cancel", with a one-tap reminder.** The product has the parts (`trial.priceAfter`, `lengthDays`, F-03), but they sit in the popup as a P1 action. The card leads with "3 things to read before you pay", which is homework. *Recommendation:* make the charge date and amount the card's headline on trial pages, with the reminder button on the card itself.

**The trigger point is late** (major). Trial terms are usually shown on the plans or pricing page (Spotify `/premium`, HelloFresh `/plans`), not on the card-entry page, and the card can take 3 to 30 s. *Recommendation:* also fire on "Start free trial" / "Try free" CTAs and plan pages (the classifier already scores these buttons).

## 2. Differentiation

What already exists:
- **TermAlert** catches "I Agree" / "Create account" clicks and shows a green/yellow/red rating with flags for auto-renewal, arbitration and data selling. It also checks weekly for terms changes. That is your card plus your change alerts. ([Chrome Web Store](https://chromewebstore.google.com/detail/termalert/iijcgppmmeimkfcpgckdajlnhldjohff))
- **AgreeGuard** detects checkout and sign-up flows and highlights red flags. ([Product Hunt](https://www.producthunt.com/products/agreeguard-ai-terms-privacy-analyzer), [Feedbagel](https://feedbagel.com/post/agreeguard-chrome-extension-summarizes-terms-and-conditions-highlights-red-flags))
- **TermsDigest** summarizes costs, cancellation terms and red flags when you hover a legal link. ([Chrome Web Store](https://chromewebstore.google.com/detail/termsdigest/elkhddigpcopldfijeaedkehfacdegeh)) TOS Summarizer uses Claude. ([Chrome Web Store](https://chromewebstore.google.com/detail/oghmkknppjhgpcaokdggkloajlfhbimn))
- **Gemini in Chrome** reached all US desktop users in Sept 2025 and answers questions about the current page. ([TechCrunch](https://techcrunch.com/2025/09/18/google-brings-gemini-in-chrome-to-us-users-unveils-agentic-browsing-capabilities-and-more/)) This is the "isn't this just asking Gemini?" question.
- **Dark-pattern extensions** already flag pre-checked add-ons. ([Dark Radar](https://addons.mozilla.org/firefox/addon/dark-radar/), [Dark Pattern Detector](https://chromeboard.com/extension/dark-pattern-detector-lkpekbgiliklbgkdejojjfjelnadedmk))
- **Trial protection** comes from Capital One Eno, which spots free trials and offers reminders ([Capital One](https://www.capitalone.com/digital/eno/spending-insights)), and from Privacy.com's merchant-locked cards, which simply decline the renewal charge ([Privacy](https://privacy.com/blog/forgot-to-cancel-subscription-refund)). Both act on the charge itself, which is stronger than a warning.
- **ToS;DR** remains the community-graded reference ([tosdr.org](https://tosdr.org)).

The README's comparison table only covers ToS;DR, a straw man in 2026. A judge will say "isn't this TermAlert?" within 10 seconds.

**Honest one-sentence wedge:** "The only terms checker that can't make up a warning: every flag is a verified sentence, and at a free-trial sign-up it turns that sentence into a dated reminder and a cancel path." Lead with proof plus action, not with "AI reads the terms".

## 3. Plan weaknesses

| # | Severity | Weakness | Recommendation |
|---|---|---|---|
| 3.1 | critical | Severity rubric: `auto_renewal` is high when there is "no reminder before charging". Almost no terms promise a reminder, so every subscription is red. | Ordinary monthly renewal with online cancel → low/info. Red only for unusual or harsh terms: phone or mail cancel, notice of 30+ days, termination fee, a trial that converts to annual, no refunds on prepaid annual plans. Show "normal for subscriptions" context. |
| 3.2 | critical | The accuracy plan (Q-01) is P1 and was satisfied with mock mode and AI-drafted labels. | Have a human relabel the 10 real texts, run eval with `LLM_PROVIDER=anthropic`, and report rules-only vs rules+LLM side by side. That comparison is your "why AI" slide. |
| 3.3 | major | Deploying the backend (A-12) is P2, so judges can't install and try the extension. | Promote it to P0 along with a packed .zip. A local-only backend also makes the "shared cache" claim false. |
| 3.4 | major | Change alerts (F-05/A-11) duplicate TermAlert and only fire on a second visit, which almost never happens at a checkout. | Cut them from the pitch; keep them as a Q&A bonus. |
| 3.5 | major | `arbitration` and `data_sharing` dilute "money first" and push sites to yellow. | Keep them in the popup only, never in the card's top 3 or the verdict. |
| 3.6 | minor | Real-site testing covered big brands. The long tail (Shopify/WooCommerce stores) is where on-the-spot analysis is the wedge, and it is untested. | Add Shopify's standard `/policies/refund-policy` and `/policies/terms-of-service` to the fallback paths, and test 3 small stores. |
| 3.7 | minor | Assumes people trust a red card from an unknown extension. | The quote does the trusting, so put one quoted line on the card itself, not only in the popup. |

## 4. Weaknesses in what's built

- **Green when the terms weren't fully read** (major). `computeVerdict` returns green when `analyzedCount > 0`. If only the privacy page was read, or the prefilter found no money paragraphs, the user still sees "No money traps found in the terms". The card says "We read N policies" but never says which ones failed. *Fix (S):* green requires a terms, refund or subscription document to be analysed. Otherwise show "Partly read (privacy only)" in grey, and list unreadable policies.
- **Coverage on real sites** (major). Your own notes show Ticketmaster and Disney+ legal pages are JavaScript apps, gyms are blocked, a dozen retailers return 403 to curl, the ASP.NET `<form>` removal wipes whole pages, and "Terms apply" links are hash/modal links. None of this was tested in a real browser. *Fix:* run the extension on the 8 sites in the notes, and fix the `form` removal and hash-only links (S).
- **Latency** (major). Worst case is a 10 s fetch per policy, plus a 12 s LLM timeout, plus a retry: well past the moment the user clicks Pay. *Fix:* show local fee and add-on findings and the rules-only verdict immediately, then upgrade when the LLM answers.
- **The shared cache is seed-only** (minor, but a pitch honesty problem). "Instant for sites anyone has scanned" is untrue on a localhost server with four seeded fixtures. Drop the claim, or deploy.
- **Permissions and install friction** (major for real use). A `<all_urls>` content script on every page, `<all_urls>` hosts, and load-unpacked only. This is the same profile Chrome-Stats flags as high risk for AgreeGuard. *Fix:* say "optional per-site permission plus activeTab on click" in the roadmap, and show that you know.
- **Privacy story has a hole** (minor). Sending `pageUrl` (origin + path) to your server means the server learns every checkout domain a user visits: a purchase history. *Fix:* send the domain only. Say plainly "our server sees which shops you check out on; it logs nothing else."
- **Fee detector on real checkouts** (minor). Real checkouts (Shopify, Stripe-hosted) put fees in iframes or on other origins. It has only been tested on Gadgetly.

## 5. Demo and pitch risks

1. **"You wrote the test and the answer."** Fake stores with planted clauses, and rules tuned to find them. *Fix:* add a 20 s beat on live Spotify Premium (its "Terms apply." link sits next to the trial button), pre-seeded but real.
2. **"Where's Claude?"** In mock mode there is no model, and the injection beat proves nothing (regex ignores instructions). Demo SneakyTerms with the real model, or say "rules-only mode" honestly.
3. **"Netflix is red too?"** If a judge tries any subscription site, it's red. Pre-empt it with the 3.1 fix.
4. **Numbers.** 70% verdict accuracy on 10 self-labelled, train-on-test items invites a teardown. Say "n=10, labels reviewed by us, rules tuned on them" or skip it.
5. **Mail and calendar handoffs** fail on venue laptops (the script already has fallbacks). Keep them under 10 s.
6. **Legal poke.** "Could a red card defame a merchant?" Answer: quotes only, "the terms state…", not legal advice.

## 6. Biggest missed opportunities

| # | Change | Effort | Impact | Why |
|---|---|---|---|---|
| 1 | **Charge-date headline.** On trial pages the card leads with "Free for 7 days, then $14.99/mo starting Nov 21", with a [Remind me] button on the card. | S | High | This is the painkiller moment and the clearest action. Competitors show a rating; you show a date and a dollar figure. |
| 2 | **Recalibrate the verdict** (3.1), and add a grey "partly read" state instead of false green. | S | High | Fixes cry-wolf and false comfort, the two things that kill trust. Demo it: "Netflix: yellow, normal renewal, cancel online. StreamNest: red, phone only." |
| 3 | **Real model on a real site, measured.** Human-reviewed labels; rules-only vs rules+Claude numbers; one live real-site beat. | M | High | Turns "a regex demo" into "AI with proof". It answers both "isn't this TermAlert" and "where's the AI". |
| 4 | **"Your rights" line on cancellation flags.** California's auto-renewal law, as amended by AB 2863 from July 1 2025, requires online cancellation for online sign-ups and covers free-to-pay trial conversions ([DWT](https://www.dwt.com/insights/2024/10/ab-2863-updates-california-automatic-renewal-law)). The federal click-to-cancel rule was vacated in July 2025 ([Fenwick](https://www.fenwick.com/insights/publications/eighth-circuit-vacates-ftcs-click-to-cancel-rule)). Example card line: "Phone-only cancel. If you're in California, the law says online sign-ups must allow online cancellation." | M | Medium-high | Nobody else does this. It is a strong pitch hook ("the federal rule died; we put the protection back in your browser"), and the cancellation email draft can cite it. Word it as information, not advice. |
| 5 | **Deploy the backend and ship a .zip** so judges can install it during judging. | S-M | Medium | Lets judges try it on a store of their choice, which persuades more than any slide. It also makes the cache claim true. |

Also cut from the pitch: change alerts, arbitration and data-sharing in the card, and the "shared cache" claim. Regulatory context worth a line: the UK drip-pricing ban has been in force since 6 April 2025 ([Hill Dickinson](https://www.hilldickinson.com/insights/articles/digital-markets-competition-and-consumers-act-2024-new-consumer-law-protections)). The FTC's fee rule covers only tickets and lodging ([FTC](https://www.ftc.gov/news-events/news/press-releases/2024/12/federal-trade-commission-announces-bipartisan-rule-banning-junk-ticket-hotel-fees)). The hidden-fee detector is your evidence for that gap in US retail.
