import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Buildless fixture UI is intentionally plain JavaScript.
import { initDemo } from '../demo/demo.js';
import { classify } from '../../extension/src/content/classifier';
import { collectPolicies } from '../../extension/src/content/collect';
import { createApp } from '../../server/src/app';
import { MockLlm } from '../../server/src/llm/mock';
import { MemoryStore } from '../../server/src/store/memory';
import request from 'supertest';
const openDoms: JSDOM[] = [];
beforeAll(() => { vi.stubGlobal('DOMParser', new JSDOM('').window.DOMParser); });
afterAll(() => vi.unstubAllGlobals());
afterEach(async () => { await new Promise((r) => setTimeout(r, 0)); for (const dom of openDoms.splice(0)) dom.window.close(); });
const html = readFileSync(join(__dirname, '../demo/index.html'), 'utf8');
function mount(storage = '{}') {
  const dom = new JSDOM(html, { url: 'http://localhost:4000' });
  openDoms.push(dom);
  const win = dom.window;
  win.localStorage.setItem('xcavate-demo-checks-v1', storage);
  win.fetch = (async (url: string) => ({ ok: true, json: async () => url.includes('healthz') ? { ok: true, llm: 'mock' } : { streamnest: 1 } })) as any;
  const controller = initDemo(win.document, win);
  return { dom, win, doc: win.document, controller };
}
describe('judge demo', () => {
  it('stays quiet on the hub, preserves real source quotes, and opens cases on independent origins', () => {
    const { dom, doc } = mount();
    expect(classify(doc, 'http://localhost:4000/').pageType).toBe('none');
    for (const button of doc.querySelectorAll<HTMLButtonElement>('.scenario')) {
      button.click();
      const quote = doc.querySelector('.quote p')!.textContent!.slice(1, -1);
      const site = button.dataset.case!;
      const file = site === 'streamnest' ? 'terms' : site === 'gadgetly' ? 'returns' : site === 'fairbox' ? 'refunds' : 'terms';
      expect(new JSDOM(readFileSync(join(__dirname, `../sites/${site}/${file}.html`), 'utf8')).window.document.body.textContent).toContain(quote);
      expect(doc.querySelector<HTMLAnchorElement>('.case-detail>a')!.href).toBe(`http://${site}.localhost:4000/checkout`);
    }
  });
  it('recovers corrupt storage and keeps rehearsal checks explicitly manual', () => {
    const { dom, doc, win } = mount('{broken');
    const check = doc.querySelector<HTMLInputElement>('#check-trial')!;
    check.click();
    expect(doc.getElementById('progress')!.textContent).toBe('1 / 14 cases observed');
    expect(JSON.parse(win.localStorage.getItem('xcavate-demo-checks-v1')!)).toEqual({ trial: true });
    doc.getElementById('clear-checks')!.click();
    expect(check.checked).toBe(false);
    expect(doc.getElementById('progress')!.textContent).toBe('0 / 14 cases observed');
  });
  it('does not claim ready when the backend fails', async () => {
    const { dom, win, doc, controller } = mount();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.getElementById('health-detail')!.textContent).toContain('rules-only');
    win.fetch = (async () => { throw new Error('offline'); }) as any;
    await controller.refreshHealth();
    expect(doc.getElementById('health')!.textContent).toBe('Backend unavailable');
    expect(doc.getElementById('version')!.textContent).toBe('Policy version unavailable');
  });
  it('launches the correct presentation beat and resets without leaving a live timer', async () => {
    const { dom, doc } = mount();
    const dialog = doc.getElementById('presentation') as HTMLDialogElement;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new dom.window.Event('close')); };
    doc.querySelector<HTMLButtonElement>('[data-present]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.getElementById('stage-prev')!.hasAttribute('disabled')).toBe(true);
    doc.getElementById('stage-next')!.click();
    expect(doc.querySelector<HTMLAnchorElement>('#stage-launch')!.href).toContain('streamnest.localhost:4000/checkout');
    doc.getElementById('timer-toggle')!.click();
    doc.getElementById('exit-stage')!.click();
    expect(doc.getElementById('timer-toggle')!.textContent).toBe('Start timer');
    doc.getElementById('timer-reset')!.click();
    expect(doc.getElementById('elapsed')!.textContent).toBe('0:00');
    expect(doc.getElementById('stage-position')!.textContent).toContain('BEAT 01');
  });
});
describe('coverage fixtures through the actual collector and backend', () => {
  for (const [site, verdict] of [['privacyonly', 'partial'], ['unreadable', 'unknown']] as const) {
    it(`${site} never becomes green`, async () => {
      const url = `http://${site}.localhost:4000/checkout`;
      const doc = new JSDOM(readFileSync(join(__dirname, `../sites/${site}/checkout.html`), 'utf8'), { url }).window.document;
      const payload = await collectPolicies(doc, url, 'checkout', { fetchHtml: async (url) => {
        try { return readFileSync(join(__dirname, `../sites/${site}/${new URL(url).pathname.slice(1)}.html`), 'utf8'); } catch { return undefined; }
      }});
      const app = createApp({ store: new MemoryStore(), llm: new MockLlm(), config: { rateLimitPerMin: 100 } });
      const response = await request(app).post('/v1/analyze').send(payload);
      expect(response.status).toBe(200);
      expect(response.body.verdict).toBe(verdict);
    });
  }
});
