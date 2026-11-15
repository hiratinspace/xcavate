# Xcavate: submission page text

Local only. Paste section by section into the submission form. Replace every `<!-- EVAL -->` with measured numbers (with sample size) before submitting, or delete the sentence.

**Tagline:** Digs up the fine print before you pay.

**Short description:** A Chrome extension that finds the money traps in a site's terms (auto-renewals, no-refund rules, cancellation hoops, added fees) and shows them at checkout, each with the exact sentence as proof.

---

## Inspiration

Most of us have paid for something we didn't mean to: a free trial that quietly became a yearly plan, a return that cost a quarter of the price, a subscription you could only cancel by phone. The catch was always written down, just on page 9 of a document nobody reads at the Pay button. The theme was "Let's dig in", so we built something that digs into the terms for you, at the one moment it matters.

## What it does

When you reach a checkout or sign-up page, Xcavate finds the site's terms, refund, subscription and privacy pages, reads them, and shows a small card with a red, yellow or green verdict and up to three plain-English warnings. Every warning quotes the exact sentence it came from, and "See in policy" opens the page with that sentence highlighted.

It also:

- calls out extra fees in the order summary ("Service fee $4.95"),
- outlines add-ons that were pre-checked for you, without ever changing them,
- sets a calendar reminder two days before a free trial charges you,
- explains how to cancel and drafts the cancellation email for you to send,
- tells you when a site's terms changed since your last visit.

A fair site gets a green verdict. The card never blocks, clicks or fills anything.

## How we built it

- **Extension:** Manifest V3 in plain TypeScript, bundled with esbuild. A content script detects checkout pages from URL words, card fields (presence only), payment iframes and button text, then finds and cleans the policy pages. The UI lives in a closed shadow DOM so the store's CSS can't break it and it can't break the store.
- **Backend:** Node and Express. The pipeline splits policies into paragraphs, keeps the money-related ones, and runs a regex rules engine and Claude (a small, fast model with structured JSON output) side by side. Every quote is verified against the source text; severity and the verdict are computed in code.
- **Shared contracts:** one package of zod schemas used by both the extension and the server, so types and runtime validation can't drift. The request schema is strict, so the server rejects anything beyond policy text and URLs.
- **Storage:** Node's built-in SQLite, caching reports by content hash and keeping policy snapshots for change alerts.
- **Test stores:** four fictional shops on `*.localhost`, including a clean control and an attack store, plus a labelled set and an eval script for precision and recall.

## Challenges we ran into

- **Not crying wolf.** One false warning on stage would undo the whole pitch. We required a verified quote for every warning and built a clean control store that has to come back green.
- **Prompt injection.** A policy is text the site controls. Our attack store hides instructions in invisible text and also states them visibly. We strip hidden text, treat the policy as untrusted data, force structured output, compute the verdict in code, and keep high-severity rules findings no matter what the model says.
- **Privacy at checkout.** Checkout pages are full of card numbers. The classifier only checks that card fields exist, never their values, and fee and add-on detection run entirely in the page.
- **Real-world plumbing.** Cross-origin policy pages, sites that render terms with JavaScript, and a native SQLite module that wouldn't compile on our Node version (we switched to the built-in one).

## Accomplishments that we're proud of

- Every warning on screen is a sentence you can click and read yourself.
- The attack store still comes back red in all its variants.
- The demo runs fully offline with the Wi-Fi off.
- Measured, not guessed: precision <!-- EVAL -->, recall <!-- EVAL --> on <!-- EVAL: n --> labelled policies; cached results in <!-- EVAL -->.

## What we learned

- Showing the proof matters more than a clever summary. A quote earns trust that a grade can't.
- With an LLM in the loop, the safest design keeps decisions in code: the model proposes, the code verifies and scores.
- A good control case (the clean store) is as important as the scary ones.

## What's next for Xcavate

- Firefox and Safari, and a Chrome Web Store release with per-site permissions.
- PDF and non-English policies.
- User corrections ("this flag is wrong") feeding the labelled set.
- A subscription tracker that remembers what you signed up for and when it renews.

*Automated summary, not legal advice.*

## Built with

TypeScript, Chrome Extensions (Manifest V3), esbuild, Node.js, Express, zod, node:sqlite, Claude API, vitest
