# The Xcavate demo room

A local stage for the real extension. Nothing here is for sale. No model accuracy claims are made.

## Launch

1. `npm install` once, then `npm run demo`.
2. Load `extension/dist` in Chrome once and pin Xcavate.
3. Open http://localhost:4000/ in that same Chrome profile.
4. Confirm **Backend ready**, **Mock provider**, and StreamNest **v1**.
5. Press **Take the 3-minute tour**. The tour restores policy v1 and resets its timer. Press **Start timer** when speaking.

The seven beats cover the hook, trial and quoted proof, reminder and cancellation, pre-checked extras, clean control, hostile terms, and closing. Arrow keys move between beats; Escape exits and pauses the timer. Each live-case link reuses a separate tab so the presenter can return to the story. Use **Open a fresh tab** on a scenario if its card was dismissed. Do not press Escape on the live checkout unless testing dismissal.

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

## Opening evidence

The opening asks the audience to think of a grandparent or someone they help online, without claiming that older people are inherently unable to use technology. It then cites one concrete subscription case: the FTC’s September 25, 2025 Amazon Prime settlement included $1.5 billion in consumer redress for an estimated 35 million people affected by unwanted enrollment or delayed cancellation. This is a refund allocation in one settlement, not a measurement of total money lost online or money already paid out.

Source: [FTC settlement announcement](https://www.ftc.gov/news-events/news/press-releases/2025/09/ftc-secures-historic-25-billion-settlement-against-amazon). The source is linked on the opening screen. Keep the opening to 30 seconds; the trial/proof beat now runs from 0:30 to 1:00.
