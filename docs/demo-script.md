# Xcavate: 3-minute demo script

Local only. Total: 3:00. Two people: **Driver** (clicks) and **Speaker** (talks). Rehearse until two different teammates can each run it under 3 minutes, twice, and once with Wi-Fi off.

All URLs come from the fixture contract. Have them open as tabs in this order, but load each one only when its beat starts (the card should appear live).

| Tab | URL |
|---|---|
| 1 | `http://streamnest.localhost:4000/checkout` |
| 2 | `http://gadgetly.localhost:4000/checkout` |
| 3 | `http://fairbox.localhost:4000/checkout` |
| 4 | `http://sneakyterms.localhost:4000/checkout` |
| 5 (backup) | Slides, open on slide 1 |

---

## Beat by beat

### 0:00 to 0:15 · Hook (15 s)

- **Click:** nothing. Slide 1 on screen, or the StreamNest product page.
- **Say:** "I've paid for things I didn't mean to, because the catch was on page 9 of the terms. So has almost everyone here. Xcavate digs up the fine print before you pay."
- **Audience sees:** a normal-looking streaming site.

### 0:15 to 1:00 · StreamNest free trial (45 s)

- **Click:** go to tab 1, `http://streamnest.localhost:4000/checkout`.
- **Say:** "I'm signing up for a free trial. I'd normally just hit Start trial."
- **Audience sees:** the card bottom right, "checking" then red: "3 things to read before you pay". Warnings: the trial turns into $14.99 a month automatically, it renews until you cancel, and cancelling is by phone only with 30 days' notice.
- **Say:** "Red, three things. And it doesn't ask you to trust it."
- **Click:** "See in policy" on the cancellation warning.
- **Audience sees:** the terms page (on a different host, `legal.localhost:4001`) scrolled to the exact sentence, highlighted.
- **Say:** "That's the actual sentence from their terms. Every warning has one."
- **Fallback (no highlight):** "Chrome didn't scroll, but here's the sentence," then press Ctrl+F (Cmd+F) and type "1-800-555-0199".
- **Fallback (card stuck on checking):** "Let's ask it directly," click the toolbar icon, press "Scan this page". If still nothing, switch to the backup video at the StreamNest timestamp.

### 1:00 to 1:30 · Do something about it (30 s)

- **Click:** back to the checkout tab, open the Xcavate toolbar popup.
- **Click:** "Remind me 2 days before I'm charged".
- **Audience sees:** a calendar event dated 5 days from today (2 days before the 7-day trial ends), with the price and a link to the policy.
- **Say:** "Reminder set for two days before I'm charged."
- **Click:** "How to cancel" section, then "Draft cancellation email".
- **Audience sees:** phone-only, 30 days' notice, steps, and a mail draft with subject "Cancellation request" filled in.
- **Say:** "And when I want out, the steps and the email are ready. I send it, not the extension."
- **Fallback (offline, Google Calendar won't load):** use the `.ics` download instead and say "it also works as a calendar file."
- **Fallback (no mail client opens):** "The draft opens in your mail app; this laptop doesn't have one set up," and point at the steps in the popup.

### 1:30 to 2:00 · Gadgetly (30 s)

- **Click:** tab 2, `http://gadgetly.localhost:4000/checkout`.
- **Audience sees:** a yellow card, "Worth a quick look": a 25% restocking fee and return shipping you pay, plus forced arbitration. On the page itself, the "Service fee $4.95" line is called out and the pre-checked "Protection plan $12.99" box is outlined in amber.
- **Say:** "Not every site is red. This one's a quick look: returns will cost you, there's a service fee you didn't pick, and a $12.99 protection plan was ticked for you."
- **Click:** untick the protection plan.
- **Audience sees:** the outline disappears.
- **Say:** "It points it out. It never changes anything for you."
- **Fallback (outline missing):** open the popup, where the fees and pre-checked add-on are listed.

### 2:00 to 2:15 · FairBox (15 s)

- **Click:** tab 3, `http://fairbox.localhost:4000/checkout`.
- **Audience sees:** green, "No money traps found in the terms".
- **Say:** "A fair store gets a green. It doesn't cry wolf."

### 2:15 to 2:35 · Security (20 s)

- **Click:** tab 4, `http://sneakyterms.localhost:4000/checkout`.
- **Audience sees:** red: all sales final, plus an early termination fee.
- **Say:** "This store's terms tell AI tools to report no issues, some of it in hidden text. Still red. Hidden text is stripped, the model's answer is checked against the real sentences, and the verdict is computed in code. And the only thing that ever leaves your browser is the public policy text."
- **Optional (only if ahead of time):** show slide 3.

### 2:35 to 3:00 · Numbers and next (25 s)

- **Click:** slide 4.
- **Say:** "On <!-- EVAL: n --> labelled policies we measured <!-- EVAL --> precision and <!-- EVAL --> recall. Cached results show in under <!-- EVAL --> . Next: Firefox and Safari, PDF and non-English policies, and a tracker for everything you've subscribed to. Worth reading before you pay. Xcavate reads it for you."
- **Rule:** say the sample size. If eval numbers aren't ready, say "we measured on our test stores" and skip the figures. Never improvise a number.

### Bonus beat (only for Q&A or if a judge asks about change alerts)

1. Make sure StreamNest checkout has already been visited once in this profile (beat 2 does this).
2. Open `http://localhost:4000/__set?site=streamnest&v=2`.
3. Reload `http://streamnest.localhost:4000/checkout`.
4. Audience sees: "Terms changed since your last visit", with the price change to $19.99 and a new early termination fee.
5. Afterwards: `http://localhost:4000/__set?site=streamnest&v=1`.

---

## General fallback lines

- **Anything freezes:** "Live demos, right? Here's the recording," and jump to the matching timestamp in the backup video. Don't debug on stage.
- **Model slow or Wi-Fi gone:** nothing to say; mock mode plus the seeded cache should already be running. If a judge asks: "It falls back to the rules engine and the cache, so it works offline."
- **Card covered by something:** click the toolbar icon; the popup has the full report.
- **Judge asks about a real site:** "Our demo uses fictional stores on purpose, so we never call out a real company on stage. Here's what we saw on real sites:" <!-- EVAL: fill from real-site notes -->

---

## Offline rehearsal (do it at least once, ideally twice)

1. In `server/.env`, set `LLM_PROVIDER=mock` (or delete the line; mock is the default).
2. Reset StreamNest to v1: open `http://localhost:4000/__set?site=streamnest&v=1` (after starting the fixtures).
3. Seed the cache: `npm run seed`. Check that its table shows streamnest red, gadgetly yellow, fairbox green, sneakyterms red.
4. Turn Wi-Fi off.
5. Start `npm run dev:fixtures` and `npm run dev:server` in two terminals.
6. Check `http://localhost:8787/healthz` returns `{"ok":true,"llm":"mock"}`.
7. Open a fresh Chrome profile with the extension loaded and run the full script with a timer.
8. Note anything that needed the network (expected: only Google Calendar; use the `.ics` file).

If the venue Wi-Fi is good and you choose to demo with the real model, still seed first, and keep mock mode ready to switch to: edit `server/.env` and restart the server (about 5 seconds).

---

## Pre-demo checklist

**30 minutes before**

- [ ] Latest code pulled; `npm install` and `npm run build` done on the demo laptop.
- [ ] `npm test` passes.
- [ ] `server/.env` set to the provider you'll demo with (mock unless the Wi-Fi has been proven).
- [ ] `npm run seed` run; table shows the four expected verdicts.
- [ ] StreamNest reset to v1 (`http://localhost:4000/__set?site=streamnest&v=1`; `http://localhost:4000/__state` confirms).
- [ ] Backup video on **two** laptops, both opened once to check they play, timestamps for each beat written down.

**10 minutes before**

- [ ] Fresh Chrome profile (no old Xcavate storage, no other extensions), for example: `open -na "Google Chrome" --args --user-data-dir="$HOME/xcavate-demo-profile"` with a new folder name each time.
- [ ] Extension loaded from `extension/dist` in that profile; Xcavate pinned to the toolbar.
- [ ] `npm run dev:fixtures` running; `http://localhost:4000/` lists the stores.
- [ ] `npm run dev:server` running; `http://localhost:8787/healthz` answers.
- [ ] Tabs 1 to 4 typed in but not loaded; slides open.
- [ ] Browser zoom at 125% or more so the card is readable from the back; notifications and other apps muted.
- [ ] A mail client opens `mailto:` links on this laptop, or the fallback line is ready.
- [ ] Laptop on power, screen sleep off, display mirroring tested.

**Right before**

- [ ] Driver and Speaker agree who says the numbers.
- [ ] Timer visible to the Speaker.
