# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: online shoppers at the moment of paying, on a checkout, sign-up, trial or pricing page. They glance at the card for about two seconds while their attention is on the purchase, and open the popup only when something looks worth reading. Secondary: hackathon judges, who see the product through a shopper's eyes in a live demo. Design for the shopper first (confirmed by the owner, 2026-11-15).

## Product Purpose

Xcavate is a Chrome extension that warns shoppers about money traps in a site's terms (auto-renewals, trials that convert to paid, hard cancellation, termination fees, no-refund rules, return costs, price changes, added fees) before they pay. It finds the site's terms, refund, subscription and privacy pages, reads them, and shows a small card with a verdict and up to three warnings. Success: the shopper notices a real trap in time, or pays with confidence on a fair site.

## Positioning

The terms checker that can't make up a warning: every warning carries the exact sentence it came from, verified against the policy text, with a link that opens the policy at that sentence. It competes on proof (verified quotes) and action (charge date, trial reminder, cancellation help) against tools that only show an AI traffic light.

## Operating Context

- In-page card: injected into arbitrary third-party checkout pages inside a closed shadow root, bottom corner, compact by default (verdict and one-line headline), expandable, movable to the other corner. It must survive hostile page CSS and never cover prices or pay buttons.
- Popup: the full report opened from the toolbar icon: every warning with severity, cost and quote, trial reminder, cancellation helper, settings (AI check on/off, pause, service address), privacy line.
- Flow: an instant on-device verdict, labelled as a quick check, then the AI-reviewed verdict replaces it a few seconds later.

## Capabilities and Constraints

- Verdicts: Read first (red), Worth a look (yellow), Looks fair (green), Partly read (could not read key pages, never green), Couldn't read. Every verdict has an icon and a word, never colour alone.
- Content script bundle must stay under 60 KB and zod-free; card CSS is inlined.
- The extension never clicks, fills, submits, blocks or changes anything on the page, and never reads form values.
- English only, Chrome only.

## Brand Commitments

- Name: Xcavate. Tagline in use: "Digs up the fine print before you pay."
- Logo idea is binding: a magnifier over layers of earth (strata), dug-up meaning. Colours, type and layout around it are open to redesign (owner, 2026-11-15).
- The owner wants the result to be distinctive and memorable, with real personality.

## Evidence on Hand

- Demo stores (fictional) on *.localhost:4000 with planted clauses; a judge demo room by a collaborator in fixtures/demo/.
- Measured accuracy is provisional (labels AI-drafted, not human-reviewed). Never present it as a benchmark in UI.

## Product Principles

1. Money first: arbitration and data sharing are listed but never drive the verdict or the card's top three.
2. Show the proof: no warning, price, phone number or date appears unless the policy text contains it.
3. Never cry wolf, never give false comfort: a clean site is green; unreadable terms are never green.
4. Never get in the way: compact, never covering the page, never touching it.
5. Informative, not legal advice: "worth reading before you pay", never "scam". Every screen says "Automated summary, not legal advice."

## Accessibility & Inclusion

Verdict never by colour alone (icon + word). The headline is a polite live region; updates of the same verdict must not re-announce. Keyboard reachable controls with visible focus; focus kept across updates. Text meets WCAG AA contrast.
