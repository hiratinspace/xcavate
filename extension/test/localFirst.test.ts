import { DEFAULT_SETTINGS, ReportSchema, SAMPLE_REPORT_GREEN, SAMPLE_REPORT_RED, type AnalyzeRequest, type Report, type TabState } from "@xcavate/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHandlers } from "../src/background/handlers";
import { Card } from "../src/content/card";
import { LOCAL_CHECK_NOTE, PRIVACY_LINE, PRIVACY_LINE_LOCAL, renderPopup, type PopupActions } from "../src/popup/render";
import { installChromeMock } from "./chromeMock";
import { setLiveDocument } from "./helpers";

/** V-06: on-device first verdict, upgraded by the backend; AI check setting. */

const TAB = 7;
const DOMAIN = "streamnest.localhost:4000";
const API = "http://localhost:8787";
const FILLER =
  "Our team works hard to bring you a great selection and friendly service. We were founded by people who love good design and fair dealing. ".repeat(4);
/** Harsh cancellation: the rules engine alone says red. */
const RED_TEXT = [
  "About us. " + FILLER,
  "Your membership renews automatically every month until you cancel.",
  "Cancellation requests must be made by telephone with at least 30 days' notice.",
].join("\n\n");

function req(text = RED_TEXT): AnalyzeRequest {
  return {
    pageUrl: "http://streamnest.localhost:4000/checkout",
    pageType: "signup",
    linksFound: 1,
    policies: [{ url: "http://streamnest.localhost:4000/terms", kind: "terms", text }],
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const backendReport = (r: Report): Report => ({ ...r, domain: DOMAIN, stats: { ...r.stats, usedLlm: true } });

let mock: ReturnType<typeof installChromeMock>;
beforeEach(() => {
  mock = installChromeMock();
});

const sentReports = () =>
  mock.chrome.tabs.sendMessage.mock.calls.filter(([, m]) => (m as { type: string }).type === "REPORT").map(([, m]) => (m as { report: Report }).report);

describe("service worker: preliminary → final", () => {
  it("sends the on-device report to the tab before the backend answers, then replaces it", async () => {
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) => new Promise<Response>((r) => (resolve = r)));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const pending = h.analyze(req(), TAB, "http://streamnest.localhost:4000/checkout");

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [local] = sentReports();
    expect(local).toBeDefined();
    expect(ReportSchema.safeParse(local).success).toBe(true);
    expect(local.verdict).toBe("red");
    expect(local.stats.usedLlm).toBe(false);
    // Tab state: preliminary, still "checking" so the popup keeps polling; badge already shows the verdict.
    expect(mock.session.data()["tab:7"]).toMatchObject({ status: "checking", localCheck: "pending" });
    expect(mock.badges.get(TAB)?.text).toMatch(/^!/);
    const mid = (await h.getState(TAB)) as TabState;
    expect(mid).toMatchObject({ status: "checking", localCheck: "pending", report: { verdict: "red" } });
    // The preliminary report never enters the per-domain cache (it would block the AI check next time).
    expect(mock.local.data()["report:" + DOMAIN]).toBeUndefined();

    resolve(jsonResponse(backendReport(SAMPLE_REPORT_GREEN)));
    const r = await pending;
    expect(r).toMatchObject({ ok: true, report: { verdict: "green", stats: { usedLlm: true } } });
    const tab = mock.session.data()["tab:7"] as Record<string, unknown>;
    expect(tab.status).toBe("ready");
    expect(tab.localReport).toBeUndefined();
    expect(tab.localCheck).toBeUndefined();
    const after = (await h.getState(TAB)) as TabState;
    expect(after.report?.verdict).toBe("green");
    expect(after.localCheck).toBeUndefined();
    expect(mock.badges.get(TAB)?.text).toBe("✓");
  });

  it("backend down keeps the local verdict: ready (not error), no STATUS error, popup note", async () => {
    const h = createHandlers({ fetchImpl: (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch });
    const r = await h.analyze(req(), TAB);
    expect(r).toMatchObject({ ok: true, report: { verdict: "red", stats: { usedLlm: false } } });
    expect(mock.session.data()["tab:7"]).toMatchObject({ status: "ready", localCheck: "unavailable" });
    expect(mock.chrome.tabs.sendMessage).not.toHaveBeenCalledWith(TAB, { type: "STATUS", status: "error" });
    expect(sentReports()).toHaveLength(1);
    const state = (await h.getState(TAB)) as TabState;
    expect(state).toMatchObject({ status: "ready", localCheck: "unavailable", report: { verdict: "red" } });

    // A later visit still tries the AI check (nothing cached from the failed run).
    const fetch2 = vi.fn(async () => jsonResponse(backendReport(SAMPLE_REPORT_RED)));
    await createHandlers({ fetchImpl: fetch2 as unknown as typeof fetch }).analyze(req(), TAB);
    expect(fetch2).toHaveBeenCalledTimes(1);
  });

  it("AI check off: nothing is sent to the backend at all, only the local verdict is used", async () => {
    await mock.local.set({ settings: { ...DEFAULT_SETTINGS, aiCheck: false } });
    // A backend report cached from earlier must not be used either.
    await mock.local.set({ ["report:" + DOMAIN]: { report: backendReport(SAMPLE_REPORT_GREEN), savedAt: Date.now() } });
    const fetchImpl = vi.fn(async () => jsonResponse(backendReport(SAMPLE_REPORT_GREEN)));
    const h = createHandlers({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const sender = { tab: { id: TAB, url: "http://streamnest.localhost:4000/checkout" } } as chrome.runtime.MessageSender;

    const ready = await h.handle({ type: "PAGE_READY", pageType: "signup", score: 5, url: "http://streamnest.localhost:4000/checkout" }, sender);
    expect(ready).not.toHaveProperty("report");
    const r = await h.handle({ type: "ANALYZE", request: req(), page: "http://streamnest.localhost:4000/checkout" }, sender);
    expect(r).toMatchObject({ ok: true, report: { verdict: "red", stats: { usedLlm: false } } });

    expect(fetchImpl).not.toHaveBeenCalled();
    const calls = fetchImpl.mock.calls as unknown[][];
    expect(calls.some((c) => String(c[0]).startsWith(API))).toBe(false);
    expect(mock.session.data()["tab:7"]).toMatchObject({ status: "ready", localCheck: "off" });
    expect(((await h.getState(TAB)) as TabState).report?.verdict).toBe("red");
  });

  it("AI check defaults to on", async () => {
    const { loadSettings } = await import("../src/lib/settings");
    expect((await loadSettings()).aiCheck).toBe(true);
    await mock.local.set({ settings: { enabled: true, apiBase: API, pausedDomains: [] } });
    expect((await loadSettings()).aiCheck).toBe(true);
  });
});

describe("card: no bad flicker between the local and the backend verdict", () => {
  beforeEach(() => setLiveDocument("<body></body>"));

  it("same verdict updates in place: the same headline node, no new announcement", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport({ ...SAMPLE_REPORT_RED, trial: undefined, stats: { ...SAMPLE_REPORT_RED.stats, usedLlm: false } });
    const before = card.shadow.querySelector(".headline");
    card.showReport({ ...SAMPLE_REPORT_RED, trial: undefined });
    const after = card.shadow.querySelector(".headline");
    expect(after).toBe(before);
    expect(card.shadow.querySelector(".card")?.hasAttribute("data-enter")).toBe(false);
  });

  it("different verdict re-renders with a fresh role=status headline", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport({ ...SAMPLE_REPORT_RED, trial: undefined });
    const before = card.shadow.querySelector(".headline");
    card.showReport(SAMPLE_REPORT_GREEN);
    const after = card.shadow.querySelector(".headline");
    expect(after).not.toBe(before);
    expect(after?.getAttribute("role")).toBe("status");
    expect(after?.textContent).toContain("No money traps found");
  });
});

describe("popup: AI check note, setting and privacy line", () => {
  let root: HTMLElement;
  const actions = (): PopupActions => ({ scan: vi.fn(), setEnabled: vi.fn(), setPaused: vi.fn(), saveApiBase: vi.fn(), setAiCheck: vi.fn(), downloadIcs: vi.fn() });
  beforeEach(() => {
    document.body.innerHTML = "<main id='app'></main>";
    root = document.getElementById("app")!;
  });

  it.each(["pending", "unavailable", "off"] as const)("shows the quiet %s note", (localCheck) => {
    renderPopup(root, { settings: DEFAULT_SETTINGS, state: { status: "ready", report: SAMPLE_REPORT_RED, localCheck } }, actions());
    expect(root.querySelector(".local-check")?.textContent).toBe(LOCAL_CHECK_NOTE[localCheck]);
    expect(root.querySelector(".error-box")).toBeNull();
  });

  it("no note for a backend report", () => {
    renderPopup(root, { settings: DEFAULT_SETTINGS, state: { status: "ready", report: SAMPLE_REPORT_RED } }, actions());
    expect(root.querySelector(".local-check")).toBeNull();
  });

  it("AI check box toggles the setting and the privacy line follows it", () => {
    const a = actions();
    renderPopup(root, { settings: DEFAULT_SETTINGS, state: { status: "idle" } }, a);
    expect(root.querySelector("footer")?.textContent).toContain(PRIVACY_LINE);
    const box = root.querySelector<HTMLInputElement>("#set-ai")!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(a.setAiCheck).toHaveBeenCalledWith(false);
    renderPopup(root, { settings: { ...DEFAULT_SETTINGS, aiCheck: false }, state: { status: "idle" } }, a);
    expect(root.querySelector("footer")?.textContent).toContain(PRIVACY_LINE_LOCAL);
    expect(root.querySelector("footer")?.textContent).not.toContain(PRIVACY_LINE);
  });
});
