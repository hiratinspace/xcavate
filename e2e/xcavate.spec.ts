import { join } from "node:path";
import {
  SCREENS,
  STORE,
  badgeText,
  cardBox,
  cardStyle,
  cardVerdict,
  clearCachedReports,
  expect,
  openPopupFor,
  readCard,
  readMarks,
  screenshotCard,
  tabIdOf,
  tabState,
  test,
  waitForCardVerdict,
  waitForStatus,
} from "./support/harness";

/**
 * V-04: extension/SMOKE_TEST.md, automated. Each test asserts what a shopper would see: the card
 * (read through CDP, it sits in a closed shadow root), the toolbar badge, the popup, and what the
 * service worker sent to the backend (counted by the proxy on :8787).
 */

const ymd = (d: Date) => d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const categories = (s: { report?: { flags: { category: string }[] } }) => (s.report?.flags ?? []).map((f) => f.category);

test.describe("Xcavate in a real Chromium", () => {
  test("1. StreamNest checkout: red, trial, cancellation friction, red badge", async ({ ext, page }) => {
    const before = ext.servers.analyzeCalls("streamnest").length;
    await page.goto(STORE("streamnest", "checkout"));
    const tabId = await tabIdOf(ext, page);

    const card = await waitForCardVerdict(page);
    const state = await waitForStatus(ext, tabId, "ready");
    expect(state.report?.verdict).toBe("red");
    expect(state.localCheck, "final report comes from the service, not the on-device pass").toBeUndefined();
    expect(cardVerdict(card)).toBe("red");
    expect(categories(state)).toEqual(expect.arrayContaining(["trial_converts", "cancellation_friction"]));
    expect(state.report?.trial?.lengthDays).toBe(7);

    // What the shopper reads on the card.
    expect(card.text).toContain("Read first");
    expect(card.text).toMatch(/Free for 7 days, then \$14\.99/);
    expect(card.text).toContain("Remind me");
    expect(card.text).toContain("not legal advice");

    const n = state.report!.flags.length;
    await expect.poll(() => badgeText(ext, tabId)).toBe("!" + n);

    // Exactly one analyze call, and it carries only the origin (V-11).
    const calls = ext.servers.analyzeCalls("streamnest").slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe("http://streamnest.localhost:4000/");

    // Card sits bottom-right of the viewport.
    const box = await cardBox(page);
    const vp = page.viewportSize()!;
    expect(box.width).toBeGreaterThan(250);
    expect(box.x + box.width).toBeGreaterThan(vp.width - 60);
    expect(box.y + box.height).toBeGreaterThan(vp.height - 60);
    await screenshotCard(page, "streamnest-card");
  });

  test("2. Gadgetly checkout: yellow, fee and pre-checked add-on, checkbox untouched", async ({ ext, page }) => {
    await page.goto(STORE("gadgetly", "checkout"));
    const tabId = await tabIdOf(ext, page);
    const card = await waitForCardVerdict(page);
    const state = await waitForStatus(ext, tabId, "ready");
    expect(state.report?.verdict).toBe("yellow");
    expect(cardVerdict(card)).toBe("yellow");

    // Local findings (stored for the popup, never sent to the backend).
    const fee = state.fees?.lines.find((l) => /service fee/i.test(l.label));
    expect(fee, "service fee line").toBeTruthy();
    expect(fee!.amount).toBeCloseTo(4.95);
    expect(state.darkPatterns?.some((d) => d.kind === "prechecked_addon" && /protection/i.test(d.label))).toBe(true);
    expect(card.text).toMatch(/Service fee \$4\.95/);
    expect(card.text).toMatch(/ticked for you/);

    // The extension never changes the shopper's choice.
    const protection = page.locator("#protection");
    await expect(protection).toBeChecked();

    const marksBefore = await readMarks(page);
    const outlines = (v: typeof marksBefore) => v.elements.filter((e) => e.attrs.class === "mark").length;
    expect(marksBefore.text).toMatch(/Pre-checked: adds \$12\.99/);
    const countBefore = outlines(marksBefore);
    expect(countBefore).toBeGreaterThanOrEqual(1);
    await screenshotCard(page, "gadgetly-card");
    await page.screenshot({ path: join(SCREENS, "e2e-gadgetly-outlines.png"), fullPage: false });

    await protection.uncheck();
    await expect.poll(async () => outlines(await readMarks(page))).toBe(countBefore - 1);
    expect((await readMarks(page)).text).not.toMatch(/Pre-checked: adds \$12\.99/);
    // Give any (wrong) re-check a chance to happen, then confirm the box stayed unticked.
    await page.waitForTimeout(2_000);
    await expect(protection).not.toBeChecked();
    // The card row and the stored findings (which feed the popup) drop the unticked plan too.
    // (The fees row may still list it: that line comes from the page's own order summary.)
    await expect.poll(async () => (await readCard(page)).text).toMatch(/1 option was ticked for you/);
    expect((await readCard(page)).text).not.toMatch(/ticked for you[^.]*Protection plan/i);
    const stateAfter = await tabState(ext, await tabIdOf(ext, page));
    expect(stateAfter.darkPatterns?.some((d) => /protection/i.test(d.label))).toBe(false);

    // The analyze body never carried the fee or add-on (proxy saw only the origin as pageUrl).
    const calls = ext.servers.analyzeCalls("gadgetly");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((c) => c.target === "http://gadgetly.localhost:4000/")).toBe(true);
  });

  test("3. FairBox checkout: green, no flags", async ({ ext, page }) => {
    await page.goto(STORE("fairbox", "checkout"));
    const tabId = await tabIdOf(ext, page);
    const card = await waitForCardVerdict(page);
    const state = await waitForStatus(ext, tabId, "ready");
    expect(state.report?.verdict).toBe("green");
    expect(state.report?.flags).toEqual([]);
    expect(cardVerdict(card)).toBe("green");
    expect(card.text).toContain("Looks fair");
    expect(card.text).not.toMatch(/Fees added at checkout|ticked for you/);
    expect((await readMarks(page)).present).toBe(false);
    await expect.poll(() => badgeText(ext, tabId)).toBe("✓");
    await screenshotCard(page, "fairbox-card");
  });

  test("4. SneakyTerms checkout: red despite the attack, hostile CSS doesn't reach the card", async ({ ext, page }) => {
    await page.goto(STORE("sneakyterms", "checkout"));
    const tabId = await tabIdOf(ext, page);
    const card = await waitForCardVerdict(page);
    const state = await waitForStatus(ext, tabId, "ready");
    expect(state.report?.verdict).toBe("red");
    expect(cardVerdict(card)).toBe("red");
    expect(categories(state)).toEqual(expect.arrayContaining(["no_refund", "termination_fee"]));

    const props = ["font-family", "font-size", "color", "background-color", "width", "position", "text-transform", "letter-spacing"];
    const hostile = await cardStyle(page, props);
    const box = await cardBox(page);
    await screenshotCard(page, "sneakyterms-card");

    // Same card on a well-behaved store (StreamNest is red too).
    const ref = await ext.context.newPage();
    try {
      await ref.goto(STORE("streamnest", "checkout"));
      await waitForCardVerdict(ref);
      const clean = await cardStyle(ref, props);
      expect(hostile).toEqual(clean);
      const refBox = await cardBox(ref);
      expect(Math.round(box.width)).toBe(Math.round(refBox.width));
      expect(Math.round(box.x + box.width)).toBe(Math.round(refBox.x + refBox.width));
    } finally {
      await ref.close();
    }
  });

  test("5. Plain article: no card, no badge, no backend call", async ({ ext, page }) => {
    const before = ext.servers.calls.length;
    await page.goto(STORE("pages", "article-1"));
    const tabId = await tabIdOf(ext, page);
    await expect.poll(async () => (await tabState(ext, tabId)).pageType).toBe("none");
    await page.waitForTimeout(2_500);
    expect((await readCard(page)).present).toBe(false);
    expect(await badgeText(ext, tabId)).toBe("");
    expect((await tabState(ext, tabId)).status).toBe("idle");
    expect(ext.servers.calls.slice(before)).toEqual([]);
  });

  test("6. ShopApp: pushState to checkout shows the card without a reload", async ({ ext, page }) => {
    await page.goto(STORE("shopapp"));
    const tabId = await tabIdOf(ext, page);
    await expect.poll(async () => (await tabState(ext, tabId)).pageType).toBe("none");
    expect((await readCard(page)).present).toBe(false);
    await page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 1));

    await page.locator("#go-checkout").click();
    await expect(page).toHaveURL(/\/checkout$/);
    await expect.poll(async () => (await readCard(page)).present, { timeout: 5_000 }).toBe(true);
    const card = await waitForCardVerdict(page);
    expect(cardVerdict(card)).toMatch(/^(red|yellow|green|partial|unknown)$/);
    await expect.poll(async () => (await tabState(ext, tabId)).status).toMatch(/^(checking|ready)$/);
    // Same document: the marker set before the click is still there.
    expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1);
    await screenshotCard(page, "shopapp-card");
  });

  test("7. Reload StreamNest: served from cache, no new analyze call", async ({ ext, page }) => {
    await page.goto(STORE("streamnest", "checkout"));
    const tabId = await tabIdOf(ext, page);
    await waitForCardVerdict(page);
    await waitForStatus(ext, tabId, "ready");
    // Let the first visit's collect + ANALYZE settle (it is a cache hit if test 1 ran).
    await page.waitForTimeout(3_000);
    const before = ext.servers.analyzeCalls("streamnest").length;

    await page.reload();
    const card = await waitForCardVerdict(page, 5_000);
    expect(cardVerdict(card)).toBe("red");
    // The content script still collects policies and asks the worker; give it time to (not) call.
    await page.waitForTimeout(4_000);
    expect(ext.servers.analyzeCalls("streamnest").length).toBe(before);
    const state = await tabState(ext, tabId);
    expect(state.status).toBe("ready");
    expect(state.report?.verdict).toBe("red");
  });

  /**
   * With the on-device rules engine (V-06), a stopped backend is not an error: the local verdict is
   * the result (status "ready", localCheck "unavailable"), FairBox stays green, and the popup says the
   * AI check was unavailable. The page itself is untouched and nothing reaches the stopped backend.
   */
  test("8. Backend down: page unaffected, on-device verdict, no backend report", async ({ ext, page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await clearCachedReports(ext);
    await ext.servers.stopBackend();
    const callsBefore = ext.servers.calls.length;
    try {
      await page.goto(STORE("fairbox", "checkout"));
      const tabId = await tabIdOf(ext, page);
      const state = await waitForStatus(ext, tabId, /^ready$/, 40_000);
      // Settle: with V-06 the status passes "checking" with a local report before "ready".
      await page.waitForTimeout(1_000);
      const final = await tabState(ext, tabId);
      expect(final.status).toBe(state.status);

      // The page itself still works.
      await expect(page.locator("#pay")).toBeVisible();
      await expect(page.locator("#pay")).toBeEnabled();
      expect(pageErrors).toEqual([]);
      expect(ext.servers.calls.length).toBe(callsBefore); // the proxy is down: nothing got through

      const popup = await openPopupFor(ext, page, tabId);
      try {
        expect(final.localCheck).toBe("unavailable");
        expect(final.report?.verdict).toBe("green");
        const card = await waitForCardVerdict(page);
        expect(cardVerdict(card)).toBe("green");
        await expect.poll(() => badgeText(ext, tabId)).toBe("✓");
        await expect(popup.getByText("Checked on your device (AI check unavailable).")).toBeVisible();
        await screenshotCard(page, "fairbox-backend-down-card");
        await popup.screenshot({ path: join(SCREENS, "e2e-popup-backend-down.png") });
      } finally {
        await popup.close();
      }
    } finally {
      await ext.servers.startBackend();
    }
  });

  test("9. Popup: See in policy text fragments, trial reminder on today + 5", async ({ ext, page }) => {
    await page.goto(STORE("streamnest", "checkout"));
    const tabId = await tabIdOf(ext, page);
    await waitForCardVerdict(page, 30_000);
    await waitForStatus(ext, tabId, "ready");

    const popup = await openPopupFor(ext, page, tabId);
    try {
      await expect(popup.locator("li.flag").first()).toBeVisible();
      const links = popup.getByRole("link", { name: "See in policy" });
      const n = await links.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) expect(await links.nth(i).getAttribute("href")).toContain("#:~:text=");
      await expect(popup.locator("blockquote").first()).toBeVisible();

      await expect(popup.getByText("Free trial: 7 days")).toBeVisible();
      const remind = popup.getByRole("link", { name: /Remind me 2 days before I'm charged/ });
      const href = (await remind.getAttribute("href"))!;
      const u = new URL(href);
      expect(u.origin + u.pathname).toBe("https://calendar.google.com/calendar/render");
      expect(u.searchParams.get("action")).toBe("TEMPLATE");
      const start = addDays(new Date(), 5);
      expect(u.searchParams.get("dates")).toBe(ymd(start) + "/" + ymd(addDays(start, 1)));
      expect(u.searchParams.get("text")).toBe("StreamNest trial ends in 2 days: cancel or keep?");
      expect(u.searchParams.get("details")).toContain("$14.99");
      await popup.screenshot({ path: join(SCREENS, "e2e-popup-streamnest.png"), fullPage: true });
    } finally {
      await popup.close();
    }
  });
});
