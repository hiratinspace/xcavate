import { test as base, chromium, expect, type BrowserContext, type CDPSession, type Page, type Worker } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_BASE, ROOT, Servers } from "./servers";

/**
 * Worker fixture: servers + a fresh Chromium profile with extension/dist loaded.
 *
 * Reading the card: it lives in a closed shadow root, which Playwright locators can't enter and
 * page.evaluate can't reach (it runs in the page's main world, not the content script's). The
 * Chrome DevTools Protocol can: DOM.getDocument with pierce:true returns closed shadow roots too.
 * So the card is read as a CDP DOM tree (text, attributes, box, computed style). Extension state
 * comes from the service worker itself: tab state through its real GET_STATE handler (sent from an
 * extension page, like the popup does), the badge through chrome.action.getBadgeText.
 */

export const DIST = join(ROOT, "extension/dist");
export const SCREENS = join(ROOT, "test-results/screens");
export const STORE = (site: string, path = "") => `http://${site}.localhost:4000/${path}`;

export interface Ext {
  context: BrowserContext;
  sw: Worker;
  id: string;
  servers: Servers;
  /** An extension page used to send runtime messages (GET_STATE) to the worker, like the popup. */
  probe: Page;
}

export interface TabSnapshot {
  status: string;
  domain?: string;
  pageType?: string;
  error?: string;
  /** V-06: set when the report shown was made on this device (pending | unavailable | off). */
  localCheck?: string;
  fees?: { currency: string; lines: { label: string; amount: number; kind: string }[]; extrasTotal: number };
  darkPatterns?: { kind: string; label: string }[];
  report?: {
    verdict: string;
    flags: { category: string; severity: string; title: string; quote: string; policyUrl: string }[];
    trial?: { lengthDays?: number; priceAfter?: string };
    policies: { url: string; status: string }[];
    /** usedLlm is true only for the e2e service's reports (its proxy marks them), never on-device ones. */
    stats: { usedLlm: boolean };
  };
}

export const test = base.extend<{ page: Page }, { ext: Ext }>({
  ext: [
    async ({}, use) => {
      if (!existsSync(join(DIST, "manifest.json"))) throw new Error("extension/dist is missing: run `npm run build -w @xcavate/extension` (npm run e2e does this)");
      mkdirSync(SCREENS, { recursive: true });
      const servers = new Servers();
      await servers.start();
      const userDataDir = mkdtempSync(join(tmpdir(), "xcavate-e2e-profile-"));
      const headed = process.env.HEADED === "1";
      const context = await chromium.launchPersistentContext(userDataDir, {
        // channel "chromium" = full Chromium build in the new headless mode, which loads extensions
        // (the default headless shell does not). HEADED=1 shows the window.
        channel: "chromium",
        headless: !headed,
        viewport: { width: 1280, height: 800 },
        args: [
          `--disable-extensions-except=${DIST}`,
          `--load-extension=${DIST}`,
          "--no-first-run",
          // The Gadgetly fixture loads tracker scripts; keep every test request on this machine.
          "--host-resolver-rules=MAP static.hotjar.com 127.0.0.1, MAP connect.facebook.net 127.0.0.1, MAP www.clarity.ms 127.0.0.1",
        ],
      });
      let [sw] = context.serviceWorkers();
      if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
      const id = new URL(sw.url()).host;
      // Point the extension at the e2e proxy before any page loads (the dev server may hold :8787).
      await sw.evaluate(
        (apiBase) => chrome.storage.local.set({ settings: { enabled: true, apiBase, pausedDomains: [], aiCheck: true } }),
        API_BASE,
      );
      const probe = await context.newPage();
      await probe.goto(`chrome-extension://${id}/popup.html`);
      try {
        await use({ context, sw, id, servers, probe });
      } finally {
        await context.close().catch(() => undefined);
        await servers.stop().catch(() => undefined);
        rmSync(userDataDir, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 90_000 },
  ],
  page: async ({ ext }, use) => {
    const page = await ext.context.newPage();
    await use(page);
    await page.close().catch(() => undefined);
  },
});

export { expect };

/** The service worker can be stopped by Chrome when idle; re-acquire it if so. */
export async function liveSw(ext: Ext): Promise<Worker> {
  try {
    await ext.sw.evaluate(() => 1);
    return ext.sw;
  } catch {
    const [sw] = ext.context.serviceWorkers().filter((w) => w.url().includes(ext.id));
    if (sw) ext.sw = sw;
    else ext.sw = await ext.context.waitForEvent("serviceworker");
    return ext.sw;
  }
}

/** Chrome's tab id for the tab showing `page` (matched by URL, newest first). */
export async function tabIdOf(ext: Ext, page: Page): Promise<number> {
  const url = page.url();
  const sw = await liveSw(ext);
  const id = await sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.filter((t) => t.url === u).sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
    return hit?.id ?? -1;
  }, url);
  if (id < 0) throw new Error("no chrome tab for " + url);
  return id;
}

/** The worker's own GET_STATE answer for this tab (the same call the popup makes). */
export async function tabState(ext: Ext, tabId: number): Promise<TabSnapshot> {
  await liveSw(ext); // wakes the worker if Chrome stopped it
  const state = await ext.probe.evaluate((tid) => chrome.runtime.sendMessage({ type: "GET_STATE", tabId: tid }), tabId);
  return (state ?? { status: "idle" }) as TabSnapshot;
}

/** The current settings in the worker's storage, patched. */
export async function setSettings(ext: Ext, patch: Record<string, unknown>): Promise<void> {
  const sw = await liveSw(ext);
  await sw.evaluate(async (p) => {
    const cur = ((await chrome.storage.local.get("settings")).settings ?? {}) as Record<string, unknown>;
    await chrome.storage.local.set({ settings: { ...cur, ...p } });
  }, patch);
}

/**
 * Wait until the tab's final result is the service's report: status "ready", no on-device marker
 * (localCheck), and the proxy's AI-checked mark. Then the card can be read as the final card.
 */
export async function waitForServiceReport(ext: Ext, tabId: number, timeout = 30_000): Promise<TabSnapshot> {
  await expect
    .poll(
      async () => {
        const s = await tabState(ext, tabId);
        return s.status === "ready" && !s.localCheck && s.report?.stats?.usedLlm === true ? "service" : `${s.status}/${s.localCheck ?? "-"}`;
      },
      { timeout, message: `tab ${tabId}: final report from the service` },
    )
    .toBe("service");
  return tabState(ext, tabId);
}

export async function badgeText(ext: Ext, tabId: number): Promise<string> {
  const sw = await liveSw(ext);
  return sw.evaluate((tid) => chrome.action.getBadgeText({ tabId: tid }), tabId);
}

export async function waitForStatus(ext: Ext, tabId: number, status: string | RegExp, timeout = 20_000): Promise<TabSnapshot> {
  const p = expect.poll(async () => (await tabState(ext, tabId)).status, { timeout, message: `tab ${tabId} status` });
  if (typeof status === "string") await p.toBe(status);
  else await p.toMatch(status);
  return tabState(ext, tabId);
}

export async function clearCachedReports(ext: Ext): Promise<void> {
  const sw = await liveSw(ext);
  await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("report:") || k.startsWith("hash:") || k === "hashIndex"));
  });
}

// ---------- CDP view of closed shadow roots ----------

interface CdpNode {
  nodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

export interface ShadowView {
  /** Whether the host element is attached to the document. */
  present: boolean;
  /** Visible text of the shadow tree (style/script excluded), whitespace collapsed. */
  text: string;
  /** All elements in the shadow tree, with attributes. */
  elements: { nodeId: number; name: string; attrs: Record<string, string> }[];
}

const sessions = new WeakMap<Page, CDPSession>();
async function cdp(page: Page): Promise<CDPSession> {
  let s = sessions.get(page);
  if (!s) {
    s = await page.context().newCDPSession(page);
    sessions.set(page, s);
  }
  return s;
}

function attrsOf(n: CdpNode): Record<string, string> {
  const out: Record<string, string> = {};
  const a = n.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) out[a[i]] = a[i + 1];
  return out;
}

function findHost(n: CdpNode, id: string): CdpNode | undefined {
  if (n.nodeType === 1 && attrsOf(n).id === id) return n;
  for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
    const hit = findHost(c, id);
    if (hit) return hit;
  }
  return undefined;
}

/** Read the (closed) shadow tree under the element with this id. */
export async function readShadow(page: Page, hostId: string): Promise<ShadowView> {
  const s = await cdp(page);
  const { root } = (await s.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: CdpNode };
  const host = findHost(root, hostId);
  const shadow = host?.shadowRoots?.[0];
  if (!host || !shadow) return { present: !!host, text: "", elements: [] };
  const texts: string[] = [];
  const elements: ShadowView["elements"] = [];
  const walk = (n: CdpNode, hidden: boolean) => {
    if (n.nodeType === 3) {
      if (!hidden && n.nodeValue) texts.push(n.nodeValue);
      return;
    }
    let h = hidden;
    if (n.nodeType === 1) {
      const attrs = attrsOf(n);
      elements.push({ nodeId: n.nodeId, name: (n.localName ?? n.nodeName).toLowerCase(), attrs });
      if (/^(style|script)$/i.test(n.nodeName) || "hidden" in attrs) h = true;
    }
    for (const c of n.children ?? []) walk(c, h);
  };
  walk(shadow, false);
  return { present: true, text: texts.join(" ").replace(/\s+/g, " ").trim(), elements };
}

export const readCard = (page: Page) => readShadow(page, "xcavate-card-host");
export const readMarks = (page: Page) => readShadow(page, "xcavate-marks-host");

export function cardVerdict(v: ShadowView): string | undefined {
  return v.elements.find((e) => e.name === "section" && (e.attrs.class ?? "").split(/\s+/).includes("card"))?.attrs["data-verdict"];
}

/**
 * The card re-renders (replaces its section) when a newer report arrives, e.g. the backend's
 * after the on-device one (V-06), which invalidates CDP node ids. Retry a few times.
 */
async function retryNode<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 4 || !/Could not find node|card section not found/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** Box (CSS px, viewport coordinates) of the card's <section class="card">. */
export const cardBox = (page: Page) => retryNode(() => cardBoxOnce(page));
async function cardBoxOnce(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const v = await readCard(page);
  const sec = v.elements.find((e) => e.name === "section" && (e.attrs.class ?? "").includes("card"));
  if (!sec) throw new Error("card section not found");
  const s = await cdp(page);
  const { model } = (await s.send("DOM.getBoxModel", { nodeId: sec.nodeId })) as { model: { border: number[] } };
  const xs = [model.border[0], model.border[2], model.border[4], model.border[6]];
  const ys = [model.border[1], model.border[3], model.border[5], model.border[7]];
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Computed style of the card section (to compare stores: hostile page CSS must not leak in). */
export const cardStyle = (page: Page, props: string[]) => retryNode(() => cardStyleOnce(page, props));
async function cardStyleOnce(page: Page, props: string[]): Promise<Record<string, string>> {
  const s = await cdp(page);
  await s.send("DOM.enable");
  await s.send("CSS.enable");
  const v = await readCard(page);
  const sec = v.elements.find((e) => e.name === "section" && (e.attrs.class ?? "").includes("card"));
  if (!sec) throw new Error("card section not found");
  const { computedStyle } = (await s.send("CSS.getComputedStyleForNode", { nodeId: sec.nodeId })) as {
    computedStyle: { name: string; value: string }[];
  };
  const out: Record<string, string> = {};
  for (const p of props) out[p] = computedStyle.find((c) => c.name === p)?.value ?? "";
  return out;
}

/** Wait until the card shows a report (not "checking") and return it. */
export async function waitForCardVerdict(page: Page, timeout = 20_000): Promise<ShadowView> {
  await expect
    .poll(async () => cardVerdict(await readCard(page)) ?? "none", { timeout, message: "card verdict" })
    .toMatch(/^(red|yellow|green|partial|unknown)$/);
  return readCard(page);
}

/** Screenshot just the card (with a small margin) into docs/screens. */
export async function screenshotCard(page: Page, name: string): Promise<string> {
  // Let the enter animation finish (it is skipped with reduced motion, but be safe).
  await page.waitForTimeout(600);
  const b = await cardBox(page);
  const vp = page.viewportSize()!;
  const m = 12;
  const clip = {
    x: Math.max(0, b.x - m),
    y: Math.max(0, b.y - m),
    width: Math.min(vp.width - Math.max(0, b.x - m), b.width + 2 * m),
    height: Math.min(vp.height - Math.max(0, b.y - m), b.height + 2 * m),
  };
  const path = join(SCREENS, `e2e-${name}.png`);
  await page.screenshot({ path, clip });
  return path;
}

/** Open the popup as a tab, pointed at `tabId` (the popup reads the active tab, so stub tabs.query). */
export async function openPopupFor(ext: Ext, target: Page, tabId: number): Promise<Page> {
  const popup = await ext.context.newPage();
  const tab = { id: tabId, url: target.url(), title: await target.title(), active: true };
  await popup.addInitScript((t) => {
    const stub = async () => [t];
    try {
      (chrome.tabs as unknown as { query: unknown }).query = stub;
    } catch {
      /* fall through */
    }
    if (chrome.tabs.query !== (stub as unknown)) Object.defineProperty(chrome.tabs, "query", { value: stub, configurable: true });
  }, tab);
  await popup.setViewportSize({ width: 400, height: 760 });
  await popup.goto(`chrome-extension://${ext.id}/popup.html`);
  return popup;
}
