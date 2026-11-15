# Xcavate

**Xcavate digs up the fine print before you pay.** A Chrome extension that finds the money traps in a site's terms (auto-renewals, no-refund rules, cancellation hoops, added fees) and shows them at checkout, each one backed by the exact sentence it came from.

Built for a hackathon with the theme "Let's dig in".

> Automated summary, not legal advice.

---

## What it does

When you land on a checkout or sign-up page, Xcavate finds the site's terms, refund, subscription and privacy pages, reads them, and puts a small card in the corner of the page.

| Feature | What you see |
|---|---|
| **Verdict card** | Red ("Read first"), yellow ("Worth a look"), green ("Looks fair") or "Couldn't read", plus up to three plain-English warnings. Every verdict has an icon and a word, not just a colour. |
| **Quoted proof** | Each warning shows the exact sentence from the policy. "See in policy" opens the page with that sentence highlighted. |
| **Hidden fees** | Extra lines in the order summary are called out, e.g. "Service fee $4.95". |
| **Pre-checked add-ons** | Boxes that were ticked for you (protection plans, memberships, donations) are outlined on the page. Xcavate never changes them. |
| **Trial reminder** | "Remind me 2 days before I'm charged" creates a Google Calendar event or an `.ics` file. |
| **Cancellation helper** | How to cancel (method, steps, notice period, contact) and a ready-to-send email draft that you send yourself. |
| **Change alerts** | "These terms changed since your last visit", with a short summary of what changed. |
| **Manual scan** | If a policy can't be fetched, open it and press "Scan this page". |

Money comes first. Warnings fall into these categories: auto-renewal, trial converts to paid, hard to cancel, early termination fee, limited refunds, return costs, price can change, extra fees, forced arbitration, data sharing, and missing policy.

Xcavate never blocks, clicks or fills anything at checkout. A clean site gets a green verdict: it is designed not to cry wolf.

## How it differs from community graders

[Terms of Service; Didn't Read](https://tosdr.org) is the best-known tool in this space and does valuable work. Xcavate answers a narrower question at a different moment.

| | Community graders | Xcavate |
|---|---|---|
| Coverage | Sites someone has already reviewed | Any site, analysed on the spot |
| Moment | Whenever you visit the site | At checkout, when the decision is made |
| Focus | Rights and privacy in general | Things that cost you money |
| Proof | Summary points | The exact quoted sentence, highlighted in the policy |

## Quick start (about 10 minutes)

**You need:** Node.js 22 or newer (the server uses the built-in `node:sqlite`; 22.13+ has it without a flag) and Google Chrome 116 or newer.

```bash
git clone https://github.com/hiratinspace/xcavate.git && cd xcavate
npm install
```

Open three terminals in the repo root:

```bash
# 1. The demo stores (fictional shops on *.localhost:4000 and a legal page host on :4001)
npm run dev:fixtures

# 2. The analysis backend on http://localhost:8787 (mock mode, no API key needed)
npm run dev:server

# 3. Build the extension into extension/dist
npm run build
```

Load the extension:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/dist` folder.

Try it: visit **http://streamnest.localhost:4000/checkout**. The card should appear within a few seconds with a red verdict about the free trial.

Other demo stores:

| URL | What to expect |
|---|---|
| `http://streamnest.localhost:4000/checkout` | Red: trial converts to paid, auto-renewal, phone-only cancellation with 30 days' notice |
| `http://gadgetly.localhost:4000/checkout` | Yellow: restocking fee and return shipping, arbitration; a service fee and a pre-checked protection plan on the page |
| `http://fairbox.localhost:4000/checkout` | Green: no money traps found |
| `http://sneakyterms.localhost:4000/checkout` | Red, even though the terms tell AI tools to report no issues |

Chrome resolves `*.localhost` to your own machine, so no hosts-file changes are needed. `http://localhost:4000/` lists every store.

To see a change alert: open StreamNest's checkout once, then visit `http://localhost:4000/__set?site=streamnest&v=2` and reload the checkout. `v=1` switches back.

### Optional: use a real model

Mock mode works fully offline and is what the tests use. To analyse with Claude instead:

```bash
cp server/.env.example server/.env
```

Then edit `server/.env`:

```
LLM_PROVIDER=anthropic
LLM_API_KEY=<your Anthropic API key>
LLM_MODEL=            # empty means claude-haiku-5-5
```

Restart `npm run dev:server`. `GET http://localhost:8787/healthz` reports which provider is active. If the model is slow or unavailable, the server still answers with rules-only results.

To pre-fill the cache so every demo store answers instantly: `npm run seed`.

## Architecture

```
 Chrome                                              Backend (Node, :8787)
┌──────────────────────────────────────────┐        ┌────────────────────────────────┐
│ Content script                           │        │ validate request (strict)      │
│  detect checkout, find policy links,     │        │ split + keep money paragraphs  │
│  fetch + clean policy text,              │        │ rules engine ──┐               │
│  fee + add-on checks (local only),       │ policy │ LLM (JSON) ────┼─ verify quotes│
│  draw card (closed shadow DOM)           │  text  │                └─ score in code│
│            │                             │ ─────▶ │ SQLite cache by content hash   │
│ Service worker                           │ ◀───── │ policy snapshots for diffs     │
│  storage, cross-origin fetch, badge      │ report └────────────────────────────────┘
│ Popup: full report and actions           │
└──────────────────────────────────────────┘
```

1. The content script scores the page (URL words, card fields, payment iframes, pay buttons). Only the presence of fields is checked, never their values.
2. It finds up to four policy links, preferring the ones in "By placing your order you agree to..." next to the pay button.
3. It fetches and cleans them, then hands the text to the service worker, which calls the backend.
4. The backend keeps only money-related paragraphs, runs a rules engine and the model side by side, drops any finding whose quote is not in the text, and computes the verdict in code.
5. Fee and add-on checks run entirely in the page and never leave the browser.

## Privacy and security

- **What leaves the browser:** public policy text, the policy URLs, and the page URL with its query string and hash removed. Nothing else. The server rejects requests with unknown fields, so cart or form data cannot slip through.
- **What stays local:** hidden fee detection and pre-checked add-on detection run in the page. Form contents, cart contents and card fields are never read or sent.
- **API key:** lives only in `server/.env` on the backend. The extension holds no secrets.
- **Quote verification:** every warning must quote text that actually appears in the policy. Anything the model cannot quote exactly is dropped and counted.
- **Prompt injection:** hidden text (`display:none`, zero font size, `aria-hidden` and similar) is stripped before analysis, policy text is framed to the model as untrusted data, output is schema-checked JSON, and the verdict is computed in code from the verified findings.
- **Rules cross-check:** a deterministic rules engine runs alongside the model. A high-severity rules finding is never removed because the model said nothing.
- **Page safety:** the card lives in a closed shadow root, so page styles can't break it and it can't break the page. It never writes to page forms or clicks anything.
- **Server hygiene:** per-IP rate limit, size caps, a fixed prompt, and logs that record domain and timing only, never request bodies.

## Project layout

```
packages/shared/   types, zod schemas, categories, verdict wording (used by both sides)
extension/         Manifest V3 extension (TypeScript, esbuild)
  src/content/     page classifier, policy finder, extractor, fees, add-ons, card
  src/background/  service worker: storage, fetches, backend calls, badge
  src/popup/       full report, trial reminder, cancellation helper
server/            Express backend
  src/pipeline/    split, prefilter, rules, verify, score, diff
  src/llm/         provider interface, Anthropic client, offline mock, prompt
  src/store/       SQLite and in-memory stores
  scripts/seed.ts  pre-analyses the demo stores
fixtures/          four fictional stores, a fixture server, and golden.json
eval/              accuracy script over the labelled set
```

## Scripts

| Command | What it does |
|---|---|
| `npm install` | Installs every workspace |
| `npm run dev:fixtures` | Serves the demo stores on `*.localhost:4000` and `legal.localhost:4001` |
| `npm run dev:server` | Starts the backend on port 8787 with reload on change |
| `npm run build` | Builds shared, server and the extension (output in `extension/dist`) |
| `npm run dev:ext` | Rebuilds the extension on change |
| `npm test` | Runs all unit and integration tests (vitest) |
| `npm run typecheck` | Type-checks every package |
| `npm run seed` | Analyses every demo store into the local cache |
| `npm run eval` | Prints precision and recall per category and writes `eval/results.md` |

## Testing

```bash
npm test        # unit + pipeline tests, no network, no API key
npm run eval    # accuracy over the labelled set
```

The tests cover the page classifier (including a check that field values are never read), policy finder, text extraction with hidden-text stripping, paragraph splitting, the rules engine, quote verification and scoring, and the fixture stores themselves.
<!-- TESTS: add fee parsing and the three-variant prompt-injection test (hidden text, visible instruction, instruction inside a quotation) once they land -->

The SneakyTerms store is the prompt-injection fixture: it hides instructions in invisible text and also states one visibly, and `terms-quoted` puts the instruction inside a quotation. All variants are expected to come back red with limited refunds and an early termination fee.

**Measured results:**

| Metric | Value |
|---|---|
| Labelled set size | <!-- EVAL: fill from eval/results.md --> |
| Flag precision | <!-- EVAL: fill from eval/results.md --> |
| Flag recall | <!-- EVAL: fill from eval/results.md --> |
| Verdict accuracy | <!-- EVAL: fill from eval/results.md --> |
| Flags dropped by quote verification | <!-- EVAL: fill from eval/results.md --> |
| Median latency, fresh analysis | <!-- EVAL: fill from eval/results.md --> |
| Latency, cached result | <!-- EVAL: fill from measured run --> |

## Limitations

Not supported in this version:

- Firefox, Safari and mobile browsers
- PDF policies and non-English policies
- Policies behind a login, or pages that only render their terms with JavaScript (use "Scan this page")
- User accounts, payments, or a Chrome Web Store listing
- Blocking, auto-declining or changing anything on the page

The extension asks for access to all sites because it has to run on any shop and fetch policy pages on other domains. A store release would narrow this to per-site permission.

## Disclaimer

Xcavate gives an automated summary of public policy text to help you decide what's worth reading before you pay. It is not legal advice, it can miss things, and a warning is not a claim that a company has done anything wrong. The demo stores are fictional.

**Automated summary, not legal advice.**
