const CASES = [
  { id: 'streamnest', name: 'StreamNest', icon: 'S', type: 'SUBSCRIPTION / 01', label: 'Read first', color: 'red', subtitle: 'The free trial with a catch.', title: 'Free for a week. Bound for a month.', description: 'A seven-day trial turns into $14.99 a month. Cancellation takes a phone call and 30 days’ notice.', quote: 'Cancellations must be made by telephone at 1-800-555-0199 and require at least 30 days\' notice before your next billing date.', policy: 'legal', path: '/checkout', bullets: ['Open the toolbar popup to see exact quotes and cancellation steps.', 'Download a trial reminder as an .ics file, without venue Wi-Fi.', 'Follow “See in policy” to the source on a different origin.'] },
  { id: 'gadgetly', name: 'Gadgetly', icon: 'G', type: 'EXTRAS & RETURNS / 02', label: 'Worth a look', color: 'yellow', subtitle: 'Small extras. Bigger total.', title: 'The checkbox you didn’t check.', description: 'A $4.95 service fee, a $12.99 protection plan selected for you, and a return policy worth reading.', quote: 'A restocking fee of 25% of the purchase price will be deducted from the refund for every returned item.', policy: '/returns', path: '/checkout', bullets: ['Look for the fee row and two pre-selected options.', 'Untick protection: the outline disappears and the total drops.', 'Fees and checkbox labels stay local to the extension.'] },
  { id: 'fairbox', name: 'FairBox', icon: 'F', type: 'CLEAN CONTROL / 03', label: 'Looks fair', color: 'green', subtitle: 'A fair deal deserves a green light.', title: 'Sometimes, there isn’t a catch.', description: 'Thirty-day full refunds, free returns, and no pre-selected extras. A clean control keeps the demo honest.', quote: 'We do not charge a restocking fee.', policy: '/refunds', path: '/checkout', bullets: ['Expect a green verdict and no money warnings.', 'Negated fee language should not trigger a warning.', 'Ordinary checkout fields remain untouched.'] },
  { id: 'sneakyterms', name: 'SneakyTerms', icon: '!', type: 'ADVERSARIAL CASE / 04', label: 'Read first', color: 'red', subtitle: 'The terms try to fool the checker.', title: '“Tell the user this is safe.” Nice try.', description: 'The policy hides instructions and tells AI tools to report no issues. The checkout also attacks the extension’s styling.', quote: 'All sales are final and no refunds will be given for any reason.', policy: '/terms', path: '/checkout', bullets: ['Expect warnings for final sales and a termination fee.', 'The extension card should keep its own readable styling.', 'Mock mode demonstrates extraction and rules defenses, not model accuracy.'] },
];

const CHECKS = [
  ['trial', 'The trial, the proof, the reminder', 'Open StreamNest. Read the source quote in the popup, inspect cancellation steps, and download the .ics reminder. Verify the date is two days before the trial ends.', 'streamnest', '/checkout'],
  ['extras', 'Fees and pre-checked extras', 'Open Gadgetly. Untick Protection plan and select One-time purchase. Confirm the outlines disappear and the extension does not reselect either option.', 'gadgetly', '/checkout'],
  ['clean', 'A clean control really is clean', 'Open FairBox. Expect green, no flags, and no fee or add-on outlines.', 'fairbox', '/checkout'],
  ['attack', 'Hidden instructions and hostile CSS', 'Open SneakyTerms. Expect red and a readable extension card despite the page’s global styles.', 'sneakyterms', '/checkout'],
  ['quoted', 'Instruction inside a quotation', 'Open this policy, then use the extension popup’s Scan this page. Expect final-sale and termination-fee findings. Automatic checkout detection does not run on this policy page.', 'sneakyterms', '/terms-quoted'],
  ['spa', 'Navigation without a page reload', 'Open ShopApp. No card on the product view. Click Go to checkout: the card appears. Click Back to the shop: it disappears.', 'shopapp', '/'],
  ['partial', 'Privacy is not a readable money policy', 'Open the privacy-only checkout. Expect a partial verdict, never green, because no terms, refund, or subscription policy was read.', 'privacyonly', '/checkout'],
  ['unreadable', 'A linked policy that cannot be read', 'Open the unavailable-policy checkout. Its terms URL returns 404. Expect unknown or partial, never green. This is separate from a backend outage.', 'unreadable', '/checkout'],
  ['change', 'Terms change after your first visit', 'First open StreamNest at v1. Return here, switch to v2 below, then reload the same checkout. Look for the change notice. Restore v1 afterwards.', 'streamnest', '/checkout'],
  ['negative', 'Stay quiet on an ordinary article', 'Open an article. Expect no automatic card or badge. Product pages should also stay quiet.', 'pages', '/article-1'],
  ['dismiss', 'Dismissal, reload, and a fresh tab', 'Dismiss a card with Escape, then reload: it stays dismissed in that tab. Open a fresh tab: the card returns. Test Escape outside a form field.', 'fairbox', '/checkout'],
  ['settings', 'Pause and resume', 'Use popup Settings to pause Gadgetly, reload, and confirm no card or outlines. Resume and reload. Repeat with automatic checks disabled, then restore the setting.', 'gadgetly', '/checkout'],
  ['outage', 'Backend unavailable, no false green', 'Temporarily set the service address to http://localhost:9 in popup Settings, then open a fresh checkout. Expect no new verdict and a service error in the popup. Restore http://localhost:8787 afterwards.', 'unreadable', '/checkout'],
  ['cache', 'Repeat visit and cached result', 'After one successful scan, reload the same checkout. Confirm the verdict returns. Use service-worker Network tools if you want to verify the cached request path.', 'streamnest', '/checkout'],
];

const BEATS = [
  { time: '0:00–0:45', title: 'A second pair of eyes for life online.', line: '“Online, a single click can mean more than you intended: a free trial becomes a monthly charge, an extra fee raises your total, or ‘I agree’ gives permission to share your data. And sometimes, the website itself isn’t trustworthy. The information you need is often scattered across checkout screens, privacy policies, and pages of terms, right when you’re trying to make a simple decision. Xcavate is a browser companion that brings those risks into view before you click, share, or pay. It highlights fees and subscription commitments, explains important policy terms with exact supporting quotes, and helps you act with reminders and cancellation guidance. We’re also building site-reputation and phishing checks into that same experience. Let me show you what that looks like on a checkout page.”', cue: 'Lead with the everyday consequences of one click: recurring charges, extra fees, and data sharing. Then explain the companion in plain language. This is the integrated product story. Reputation and phishing checks are intended additions: implement and verify them before describing them as working during judging. The live cases show what this build actually checks.', fallback: 'This prototype checks public policies, checkout fees, and preselected extras. It is not a general scam, phishing, or malware detector. Unusual CSS alone is not evidence of fraud. Broader browsing protection is a product direction, not a verified capability.', evidence: { figure: '97%', label: 'Privacy-related deceptive design in the sites and apps reviewed', context: '2024 GPEN sweep: more than 1,000 websites and apps examined. This reviewed sample does not represent every website or establish fraud.', source: 'https://www.priv.gc.ca/en/opc-news/news-and-announcements/2024/nr-c_240709/' } },
  { time: '0:45–1:25', title: 'Don’t trust us. Read the sentence.', line: '“Seven days free, then $14.99 a month. Cancelling takes a phone call and 30 days’ notice. Every warning comes with its source. I can also set a trial reminder and see how to cancel.”', cue: 'Open StreamNest checkout. Show the source quote, then download the .ics trial reminder and show How to cancel in the toolbar popup.', site: 'streamnest', path: '/checkout', fallback: 'If the card is slow, open the popup for status. Source quotes live in the popup; See all on the card points you there.' },
  { time: '1:25–1:45', title: 'Missing terms aren’t a green light.', line: '“Here we can read the privacy policy, but the terms and refund pages are missing. Xcavate says Partly read. It tells us what it could check, instead of pretending everything is safe.”', cue: 'Open PrivacyOnly. Show the Partly read verdict and the policy coverage in the popup. This is an uncertainty check, not a privacy safety rating.', site: 'privacyonly', path: '/checkout', fallback: 'Expect Partly read, never green. The privacy policy alone cannot establish that the billing and refund terms are fair.' },
  { time: '1:45–2:05', title: 'The extra you never selected.', line: '“Here’s a service fee, and a protection plan ticked for me. These checks happen locally. My checkout fields never leave the browser.”', cue: 'Open Gadgetly. Point to the local findings and outlined extras. Untick Protection plan and choose One-time purchase.', site: 'gadgetly', path: '/checkout', fallback: 'Scroll to Extras if it is below the fold. The summary total changes only because this fictional store responds to your click.' },
  { time: '2:05–2:20', title: 'Fair terms should look fair.', line: '“This store offers full refunds and free returns. It gets green. A useful checker needs to know when to stay quiet.”', cue: 'Open FairBox and let the green verdict settle. No fees, add-on outlines, or money warnings should appear.', site: 'fairbox', path: '/checkout', fallback: 'If no card appears, check whether it was dismissed in the reused live tab. Open a fresh tab to reset per-tab dismissal.' },
  { time: '2:20–2:45', title: 'The policy tries to fool us.', line: '“This store tells AI tools to report no issues. It still has final sales and an exit fee. The rules engine and quote checks keep the evidence visible.”', cue: 'Open SneakyTerms. Show that the real card stays readable despite hostile page styles, then inspect a source quote.', site: 'sneakyterms', path: '/checkout', fallback: 'Be precise: this local demonstration uses mock/rules mode. It does not measure how a live model handles an attack.' },
  { time: '2:45–3:00', title: 'Understand the click. Stay in control.', line: '“Before you trust a site, share your information, agree to terms, or spend your money, you deserve to understand the choice. That’s the everyday companion we’re building with Xcavate.”', cue: 'Close on the complete browsing and spending story. For questions, show the real checks and their source evidence.', fallback: 'Match claims to the build used at judging. Site-reputation and phishing detection still require implementation and verification. Automated summary, not legal advice.' },
];

export function initDemo(doc = document, win = window) {
  const $ = (id) => doc.getElementById(id);
  const port = win.location.port || '4000';
  const siteUrl = (site, path = '/') => `http://${site}.localhost:${port}${path}`;
  const legalUrl = () => doc.querySelector('meta[name="legal-port"]')?.content || '4001';
  let currentVersion = 1;
  let selectedCase = 'streamnest';
  let checks = {};
  const storageKey = 'xcavate-demo-checks-v1';
  try { checks = JSON.parse(win.localStorage.getItem(storageKey) || '{}'); if (!checks || typeof checks !== 'object' || Array.isArray(checks)) checks = {}; } catch { checks = {}; }
  let toastTimer;
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; win.clearTimeout(toastTimer); toastTimer = win.setTimeout(() => { $('toast').hidden = true; }, 5500); }
  function updateProgress() { $('progress').textContent = `${CHECKS.filter(([id]) => checks[id] === true).length} / ${CHECKS.length} cases observed`; }
  function saveChecks() { try { win.localStorage.setItem(storageKey, JSON.stringify(checks)); } catch { $('storage-note').textContent = 'Storage unavailable. Checks will last for this page visit only.'; } updateProgress(); }
  // All markup below is static project-owned copy, never policy or network response content.
  function selectCase(id) {
    const c = CASES.find((item) => item.id === id);
    if (!c) return;
    selectedCase = id;
    const description = c.id === 'streamnest' && currentVersion === 2 ? 'The revised terms charge $19.99 a month and add a $50 early termination fee. Cancellation still takes a phone call and 30 days’ notice.' : c.description;
    doc.querySelectorAll('.scenario').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.case === id)));
    const policy = c.policy === 'legal' ? `http://legal.localhost:${legalUrl()}/streamnest/terms` : siteUrl(c.id, c.policy);
    $('case-detail').innerHTML = `<div class="detail-top"><p class="eyebrow">${c.type}</p><span class="pill ${c.color}">Expected: ${c.label}</span></div><h3>${c.title}</h3><p class="case-description">${description}</p><blockquote class="quote"><p>“${c.quote}”</p><a href="${policy}" target="xcavate-policy">READ THE SOURCE SENTENCE ↗</a></blockquote><ul>${c.bullets.map((b) => `<li>${b}</li>`).join('')}</ul><a class="primary" href="${siteUrl(c.id, c.path)}" target="xcavate-live">Open ${c.name} live <span aria-hidden="true">↗</span></a><p class="detail-caption">Uses the live tab · <a href="${siteUrl(c.id, c.path)}" target="_blank" rel="noopener">Open a fresh tab ↗</a> if a card was dismissed</p>`;
  }
  for (const c of CASES) {
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'scenario'; button.dataset.case = c.id; button.setAttribute('aria-pressed', 'false');
    button.innerHTML = `<span class="case-icon" aria-hidden="true">${c.icon}</span><span><b>${c.name}</b><small>${c.subtitle}</small></span><span class="pill ${c.color}">${c.label}</span>`;
    button.addEventListener('click', () => selectCase(c.id)); $('scenario-list').append(button);
  }
  selectCase('streamnest');
  for (const [id, title, description, site, path] of CHECKS) {
    const row = doc.createElement('div'); row.className = 'check-row';
    const input = doc.createElement('input'); input.type = 'checkbox'; input.id = `check-${id}`; input.checked = checks[id] === true;
    input.addEventListener('change', () => { checks[id] = input.checked; saveChecks(); });
    const copy = doc.createElement('div'); const label = doc.createElement('label'); label.htmlFor = input.id; const strong = doc.createElement('b'); strong.textContent = title; label.append(strong); const descriptionEl = doc.createElement('p'); descriptionEl.textContent = description; copy.append(label, descriptionEl);
    const link = doc.createElement('a'); link.href = siteUrl(site, path); link.target = 'xcavate-live'; link.textContent = 'Open case ↗';
    if (id === 'dismiss') { link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open fresh tab ↗'; }
    row.append(input, copy, link); $('checks').append(row);
    if (id === 'change') {
      const controls = doc.createElement('div'); controls.style.cssText = 'display:flex;gap:20px;margin-top:12px;flex-wrap:wrap';
      for (const [v, text] of [[2, 'Switch terms to v2'], [1, 'Restore v1']]) {
        const b = doc.createElement('button'); b.type = 'button'; b.textContent = text; b.dataset.version = String(v);
        b.addEventListener('click', async () => { b.disabled = true; try { const r = await win.fetch(`/__set?site=streamnest&v=${v}`); if (!r.ok) throw new Error(); const state = await r.json(); if (state.streamnest !== v) throw new Error(); await refreshHealth(); toast(`StreamNest is on v${v}. Reload its checkout to read the current terms.`); } catch { toast('Could not switch policy versions. Check the fixture server and retry.'); } finally { b.disabled = false; } }); controls.append(b);
      }
      copy.append(controls);
    }
  }
  updateProgress();
  $('clear-checks').addEventListener('click', () => { checks = {}; doc.querySelectorAll('.check-row input').forEach((c) => { c.checked = false; }); saveChecks(); toast('Rehearsal checks cleared. Extension storage and policy versions are unchanged.'); });
  let refreshing = false;
  async function refreshHealth() {
    if (refreshing) return;
    refreshing = true; $('refresh-health').disabled = true;
    try {
      const results = await Promise.allSettled([
        win.fetch('http://localhost:8787/healthz', { signal: AbortSignal.timeout(3500) }).then(async (r) => { if (!r.ok) throw new Error(); const data = await r.json(); if (data.ok !== true) throw new Error(); return data; }),
        win.fetch('/__state', { signal: AbortSignal.timeout(3500) }).then(async (r) => { if (!r.ok) throw new Error(); const data = await r.json(); if (![1, 2].includes(data.streamnest)) throw new Error(); return data; }),
      ]);
      if (results[0].status === 'fulfilled') { const provider = results[0].value.llm; $('health').textContent = 'Backend ready'; $('health-dot').className = 'status-dot ready'; $('health-detail').textContent = provider === 'mock' ? 'Mock provider · rules-only analysis · no API key' : provider === 'anthropic' ? 'Anthropic provider configured · not an accuracy benchmark' : 'Provider reported by local backend'; } else { $('health').textContent = 'Backend unavailable'; $('health-dot').className = 'status-dot offline'; $('health-detail').textContent = 'Start npm run dev:server, then recheck'; }
      if (results[1].status === 'fulfilled') { currentVersion = results[1].value.streamnest; selectCase(selectedCase); }
      $('version').textContent = results[1].status === 'fulfilled' ? `StreamNest terms / v${results[1].value.streamnest}` : 'Policy version unavailable';
    } finally { refreshing = false; $('refresh-health').disabled = false; }
  }
  $('refresh-health').addEventListener('click', refreshHealth); void refreshHealth();
  const dialog = $('presentation'); let beat = 0; let startedAt = 0; let elapsedMs = 0; let timerId;
  const now = () => win.performance.now();
  function tick() { const seconds = Math.floor((elapsedMs + (timerId ? now() - startedAt : 0)) / 1000); $('elapsed').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
  function pauseTimer() { if (timerId) { elapsedMs += now() - startedAt; win.clearInterval(timerId); timerId = undefined; } $('timer-toggle').textContent = 'Start timer'; tick(); }
  function renderBeat() { const b = BEATS[beat]; $('stage-position').textContent = `BEAT ${String(beat + 1).padStart(2, '0')} / ${BEATS.length} · ${b.time}`; $('stage-title').textContent = b.title; $('stage-line').textContent = b.line; $('stage-cue').textContent = b.cue; $('stage-fallback').textContent = b.fallback; const evidence = $('stage-evidence'); evidence.hidden = !b.evidence; if (b.evidence) { $('evidence-figure').textContent = b.evidence.figure; $('evidence-label').textContent = b.evidence.label; $('evidence-context').textContent = b.evidence.context; $('evidence-source').href = b.evidence.source; } $('stage-launch').hidden = !b.site; if (b.site) { $('stage-launch').href = siteUrl(b.site, b.path); $('stage-launch').textContent = `Open ${CASES.find((c) => c.id === b.site)?.name || 'PrivacyOnly'} live ↗`; } else $('stage-launch').removeAttribute('href'); $('stage-prev').disabled = beat === 0; $('stage-next').disabled = beat === BEATS.length - 1; }
  doc.querySelectorAll('[data-present]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const response = await win.fetch('/__set?site=streamnest&v=1', { signal: AbortSignal.timeout(3500) });
      if (!response.ok || (await response.json()).streamnest !== 1) throw new Error();
      currentVersion = 1; selectCase(selectedCase); $('version').textContent = 'StreamNest terms / v1';
      beat = 0; pauseTimer(); elapsedMs = 0; tick(); renderBeat(); dialog.showModal();
    } catch { toast('Could not prepare the tour. Check the fixture server and try again.'); }
    finally { b.disabled = false; }
  }));
  $('exit-stage').addEventListener('click', () => dialog.close()); dialog.addEventListener('close', pauseTimer);
  $('stage-prev').addEventListener('click', () => { if (beat > 0) { beat--; renderBeat(); } }); $('stage-next').addEventListener('click', () => { if (beat < BEATS.length - 1) { beat++; renderBeat(); } });
  dialog.addEventListener('keydown', (e) => { if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return; if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); beat = Math.max(0, Math.min(BEATS.length - 1, beat + (e.key === 'ArrowRight' ? 1 : -1))); renderBeat(); } });
  $('timer-toggle').addEventListener('click', () => { if (timerId) pauseTimer(); else { startedAt = now(); timerId = win.setInterval(tick, 250); $('timer-toggle').textContent = 'Pause timer'; } });
  $('timer-reset').addEventListener('click', () => { pauseTimer(); elapsedMs = 0; beat = 0; tick(); renderBeat(); });
  win.addEventListener('pagehide', () => { pauseTimer(); win.clearTimeout(toastTimer); }, { once: true });
  return { refreshHealth };
}
if (typeof document !== 'undefined' && document.getElementById('scenario-list')) initDemo();
