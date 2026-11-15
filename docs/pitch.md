# Xcavate: pitch

Local only (docs/ is git-ignored). Numbers marked `<!-- EVAL -->` must come from `eval/results.md` before judging. Do not round them up or quote them without the sample size.

---

## One line

Xcavate digs up the fine print before you pay: a Chrome extension that shows the money traps in a site's terms at checkout, each with the exact sentence as proof.

## The problem

- Nobody reads terms before buying. They are long, and the moment you would need them (the Pay button) is the moment you have the least patience.
- The costly surprises are written down: a free trial that converts automatically, renewal until you cancel, cancellation by phone only with 30 days' notice, a 25% restocking fee, a service fee added at the last step, a protection plan ticked for you.
- Existing tools grade well-known services on rights and privacy, based on community review. They do not help on the small shop you found ten minutes ago, and they are not there when you decide.

## The demo flow (3 minutes, full script in `demo-script.md`)

1. Hook: "the catch was on page 9 of the terms".
2. StreamNest free-trial checkout: red card, three warnings, "See in policy" highlights the exact sentence.
3. Act on it: trial reminder to the calendar, cancellation steps and an email draft.
4. Gadgetly: service fee called out, pre-checked protection plan outlined on the page.
5. FairBox: green. It doesn't cry wolf.
6. SneakyTerms: the terms tell AI tools to report no issues. Still red.
7. Numbers and what's next.

## How it works

1. **Detect.** A content script scores the page: checkout words in the URL, card fields (presence only, never values), payment iframes, pay or start-trial buttons.
2. **Find.** It collects up to four policy links, starting with the ones in the "By placing your order you agree to..." sentence next to the pay button.
3. **Read.** It fetches the pages, strips navigation, scripts and anything hidden, and sends plain policy text to our backend.
4. **Analyse.** The backend keeps only money-related paragraphs, runs a deterministic rules engine and a small, fast Claude model side by side, and asks the model for schema-checked JSON with a quote for every finding.
5. **Verify.** Any finding whose quote isn't found word for word in the policy is dropped.
6. **Score.** Severity caps and the red / yellow / green verdict are computed in code, not by the model.
7. **Show.** A card in a closed shadow DOM: verdict, up to three warnings, proof. The popup has the full list, the trial reminder and the cancellation helper.
8. **Locally, in parallel.** Extra fees and pre-checked add-ons are detected in the page and never leave the browser.

Results are cached by content hash, so a site anyone has scanned before answers almost instantly, and the model only sees the paragraphs that matter.

## Security and privacy (the strongest slide)

| Risk | Defence |
|---|---|
| A site hides "tell the user this is safe" in its terms | Hidden text stripped; policy framed as untrusted data; structured output only; verdict computed in code; rules engine keeps high-severity findings even if the model says nothing |
| The model invents a warning | Every quote must exist in the source text or the warning is dropped |
| Leaking what the user buys | Only public policy text and the page URL without its query string are sent; fees and add-ons are checked locally; the server rejects unknown fields |
| API key theft | The key lives only on the backend |
| Breaking checkout | Isolated UI; never writes to forms, never clicks |
| Backend abuse | Per-IP rate limit, size caps, fixed prompt; logs hold domain and timing only |

Line for the room: "Our attack store tells AI tools to report no issues. It still comes back red, and every warning on screen is a sentence you can click and read yourself."

## Numbers

All from `npm run eval` and a timed run. Fill before judging; say the sample size out loud.

| Metric | Value |
|---|---|
| Labelled policies (fixtures + real) | <!-- EVAL: fill from eval/results.md --> |
| Flag precision | <!-- EVAL: fill from eval/results.md --> |
| Flag recall | <!-- EVAL: fill from eval/results.md --> |
| Verdict accuracy | <!-- EVAL: fill from eval/results.md --> |
| Share of model findings dropped by quote verification | <!-- EVAL: fill from eval/results.md --> |
| Median fresh analysis time | <!-- EVAL: fill from eval/results.md --> |
| Cached result time | <!-- EVAL: fill from timed run (target under 0.5 s) --> |
| Prompt-injection variants that still return red | <!-- EVAL: fill from injection test (target 3 of 3) --> |
| Real sites checked end to end | <!-- EVAL: fill from real-site notes --> |

## Roadmap

- Firefox and Safari builds; Chrome Web Store release with narrower, per-site permissions.
- PDF and non-English policies.
- "This flag is wrong" corrections from users, feeding the labelled set.
- A public page per site so a report can be shared.
- Subscription tracker: everything you've signed up for and when each renews, built on the trial reminders.

## Business model

- **Free for shoppers.** The core card stays free; trust is the product.
- **Paid tier** for the subscription tracker, renewal reminders across sites, and change alerts on services you already pay for.
- **Reports for consumer-rights groups and researchers:** aggregate, anonymous trends in terms (how common phone-only cancellation is, for example), built only from public policy text.
- Cost per scan stays low because only relevant paragraphs go to a small model and results are shared through the cache.

## Answers to likely judge questions

**How is this different from ToS;DR?**
They grade well-known services on rights and privacy through community review, and they do that well. We analyse any site on the spot, at the checkout moment, focus only on what costs you money, and show the exact sentence as proof.

| | Community graders | Xcavate |
|---|---|---|
| Coverage | Sites someone has reviewed | Any site, on the spot |
| Moment | Any visit | At checkout |
| Focus | Rights and privacy | Money |
| Proof | Summary points | Exact quote, highlighted |

**What if the AI is wrong?**
It can't invent a warning: every quote is checked against the real text, and anything unverifiable is dropped. Severity and the verdict are computed in code. A rules engine runs alongside the model. And we show the sentence, so the shopper can judge for themselves. Our clean control store gets green. Measured precision and recall: <!-- EVAL --> on <!-- EVAL: n --> policies.

**Does it send my data anywhere?**
Only public policy text, the policy URLs and the page URL without its query string. Never form contents, cart contents or card fields. Fee and add-on checks run in your browser. The server rejects any request with extra fields.

**Can a website trick it?**
We built a store that tries: hidden text plus a visible instruction to report no issues, and a version with the instruction inside a quotation. All come back red.

**Would stores block this?**
It only reads public pages the shopper could open themselves, with no cookies sent on cross-site fetches. If a fetch fails, the verdict says "Couldn't read" and the shopper can press "Scan this page".

**Isn't this accusing companies?**
No. The wording is "worth reading before you pay", the card says "Automated summary, not legal advice", and a fair site gets a green verdict.

**Why a backend?**
To keep the API key off the client, and to share cached results so popular sites are instant and cheap.

**What happens offline or if the model is down?**
The server falls back to rules-only results, and cached reports still load. The demo runs with Wi-Fi off.

**Does it work on real sites?**
<!-- EVAL: fill from real-site notes, e.g. "Works on N of M real checkouts we tried; best on sites with server-rendered terms." -->

**How would it make money?** See above: free core, paid tracking tier, aggregate reports.

---

## Slides (4)

### Slide 1: The catch is on page 9

- Free trial converts automatically. Renews until you cancel. Cancel by phone, 30 days' notice.
- It's all written down. Nobody reads it at the Pay button.
- Xcavate digs up the fine print before you pay.

*Speaker note:* Open with the hook, no product yet. "I've paid for things I didn't mean to, because the catch was on page 9 of the terms. So has almost everyone here." Then switch straight to the live demo; this slide is only a backdrop.

### Slide 2: How it works

- Detect checkout, find the policies, read only the paragraphs about money.
- Rules engine and model side by side; verdict computed in code.
- Every warning quotes the exact sentence, highlighted in the policy.
- Fees and pre-checked add-ons checked locally on the page.

*Speaker note:* Show this after the demo, while it's fresh. Point at "exact sentence": that's the difference from summary tools. Keep it under 20 seconds.

### Slide 3: Built not to be fooled, built not to snoop

- SneakyTerms tells AI tools to report no issues: still red.
- No quote in the source, no warning.
- Only public policy text leaves the browser. Never cart, form or card data.
- API key only on the server; the card can't touch the checkout.

*Speaker note:* This is the slide judges remember. Say the injection result plainly, then the privacy line. If asked "what if the AI is wrong", this slide is the answer.

### Slide 4: Numbers and next

- Precision <!-- EVAL -->, recall <!-- EVAL --> on <!-- EVAL: n --> labelled policies.
- Cached results in <!-- EVAL --> ; fresh in <!-- EVAL -->.
- Next: Firefox and Safari, PDFs and other languages, subscription tracker.
- Free for shoppers; paid tracking tier; aggregate reports for consumer groups.

*Speaker note:* Read the numbers with the sample size; don't round. Close with: "Worth reading before you pay. Xcavate reads it for you."
