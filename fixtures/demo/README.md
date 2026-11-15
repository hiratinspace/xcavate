# The Xcavate demo room

A local stage for the real extension. Nothing here is for sale. No model accuracy claims are made.

## Launch

1. `npm install` once, then `npm run demo`.
2. Load `extension/dist` in Chrome once and pin Xcavate.
3. Open http://localhost:4000/ in that same Chrome profile.
4. Confirm **Backend ready**, **Mock provider**, and StreamNest **v1**.
5. Press **Take the 3-minute tour**. The tour restores policy v1 and resets its timer. Press **Start timer** when speaking.

The seven beats cover the hook (no case launch), StreamNest trial and quoted proof with reminder and cancellation, PrivacyOnly incomplete coverage, Gadgetly pre-checked extras, FairBox clean control, SneakyTerms hostile terms, and closing. Each case appears once, with its name on the launch button. Arrow keys move between beats; Escape exits and pauses the timer. Each live-case link reuses a separate tab so the presenter can return to the story. Use **Open a fresh tab** on a scenario if its card was dismissed. Do not press Escape on the live checkout unless testing dismissal.

The `.ics` reminder is the reliable offline action. Google Calendar needs Wi-Fi. An email draft can open a mail app; it is not sent automatically. This is rules-only mock mode: it does not demonstrate a live LLM or establish real-site accuracy.

## Rehearsal

The lower checklist includes all four primary stores, quoted injection, SPA navigation, privacy-only coverage, unreadable terms, version changes, ordinary articles, dismissal, settings, backend failure, and caching. Mark a box only after observing the behavior. The hub does not inspect extension internals. These boxes are manual notes, saved locally, not test results.

For change alerts, open StreamNest at v1, return to the hub, switch to v2, then reload its checkout. Confirm the updated policy amount and change notice. Restore v1 afterwards. The store's original checkout price is intentionally unchanged in this policy-change fixture; inspect the changed *terms*, not the order summary. Starting a presentation restores v1 automatically.

For an outage, change the extension service address to localhost port 9 temporarily, then restore port 8787. Existing cached reports can still appear, so use a fresh domain/profile when validating a completely cold outage. Do not delete anyone's existing cache or database for a rehearsal.

For performance or privacy claims, inspect Chrome's service-worker Network tools; the manual checkboxes alone do not prove them. The detailed original browser smoke checklist is in `extension/SMOKE_TEST.md`.

## Checks

- `npm test`: includes exact source-copy checks, hub behavior, allowlisted routing, and coverage cases through the real extension collector and backend.
- `npm run typecheck` and `npm run build`.
- `XCAVATE_API=http://localhost:8787 npx vitest run --project extension backend.live`: four primary stores through the running backend.

The fixture directory remains at http://localhost:4000/fixtures. Static assets require no CDN or external font. Stop `npm run demo` with Ctrl+C. The extension remains installed but its local backend stops with the rehearsal.

## Opening evidence and positioning

The 45-second opening positions Xcavate as an everyday decision helper, organized around four questions: What will this cost? What am I agreeing to? What happens to my data? How can I get out? It starts with the consequences of an everyday click: recurring charges, extra fees, and data sharing. It then explains the browser companion in plain language and leads directly into checkout.

The opening screen cites the [2024 global privacy sweep, reported by the Privacy Commissioner of Canada](https://www.priv.gc.ca/en/opc-news/news-and-announcements/2024/nr-c_240709/). Of more than 1,000 websites and apps reviewed, 97% used one or more deceptive design patterns that may influence people to provide more personal information. This was the reviewed sample, not all websites, a monetary-loss estimate, or a finding that 97% of sites are scams. The figure stays on screen; the spoken hook focuses on everyday decisions. The Amazon settlement and subscription-only prevalence figure have been removed.

Current demonstration: public-policy findings, including data-sharing and dispute terms; checkout fees and preselected extras; exact-source evidence; trial reminders and cancellation guidance. Automatic scanning is triggered on supported purchasing and signup contexts, not every page of the internet. Data sharing and arbitration appear in the fuller report and do not drive the money-focused verdict. A privacy-only unreadable-money-policy case must not be described as a privacy safety rating.

Broader vision: a trusted companion for informed browsing and spending. Site-reputation checks and phishing warnings are integrated into the opening as the intended product design, using “designed to” rather than claiming they are demonstrated. Neither is implemented in this build. Before presenting either as working at judging, implement and verify it. There is no separate roadmap slide. Implementation reminders stay in the expandable Presenter notes, closed by default; the live-case launcher remains visible. Malware detection and detecting every suspicious interface are not implemented capabilities. Concealed information and manipulative controls can be relevant signals, but minified, unusual, or hostile CSS alone does not establish that a website is fraudulent. The hostile-CSS fixture proves the extension card remains isolated; it does not prove the store is a scam.

Opening runs 0:00–0:45 without a live-case link; the remaining beats have been retimed to keep the full story at three minutes. Research links need a network; the quoted figure and source attribution remain visible offline.
