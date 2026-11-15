import { DEFAULT_SETTINGS, DISCLAIMER, SAMPLE_REPORT_GREEN, SAMPLE_REPORT_RED, textFragmentUrl } from "@xcavate/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderPopup, type PopupActions, type PopupView } from "../src/popup/render";

function actions(): PopupActions {
  return { scan: vi.fn(), setEnabled: vi.fn(), setPaused: vi.fn(), saveApiBase: vi.fn(), downloadIcs: vi.fn() };
}

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = "<main id='app'></main>";
  root = document.getElementById("app")!;
});

const base: PopupView = { settings: DEFAULT_SETTINGS, domain: "streamnest.localhost:4000", tabTitle: "Start your free trial | StreamNest", today: new Date(2026, 10, 14) };

describe("popup render", () => {
  it("red report: every flag with summary, cost, quote and a See in policy text-fragment link", () => {
    renderPopup(root, { ...base, state: { status: "ready", report: SAMPLE_REPORT_RED } }, actions());
    expect(root.querySelector("h1")?.textContent).toBe("4 things to read before you pay");
    expect(root.querySelectorAll(".flag").length).toBe(SAMPLE_REPORT_RED.flags.length);
    expect(root.querySelectorAll("blockquote").length).toBe(4);
    expect(root.textContent).toContain("Cost: $14.99 every month after the trial");
    const f = SAMPLE_REPORT_RED.flags[0];
    const link = Array.from(root.querySelectorAll("a")).find((a) => a.textContent === "See in policy")!;
    expect(link.getAttribute("href")).toBe(textFragmentUrl(f.policyUrl, f.quote));
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(root.textContent).toContain(DISCLAIMER);
    expect(root.textContent).toContain("Policies read");
  });

  it("shows the trial reminder (F-03) and how to cancel (F-04)", () => {
    renderPopup(root, { ...base, state: { status: "ready", report: SAMPLE_REPORT_RED } }, actions());
    const cal = Array.from(root.querySelectorAll("a")).find((a) => a.textContent === "Remind me 2 days before I'm charged")!;
    expect(cal.getAttribute("href")).toContain("dates=20261119/20261120");
    expect(root.textContent).toContain("By phone only");
    expect(root.textContent).toContain("30 days before your next billing date");
    const draft = Array.from(root.querySelectorAll("a")).find((a) => a.textContent === "Draft cancellation email")!;
    expect(draft.getAttribute("href")).toMatch(/^mailto:\?subject=Cancellation%20request/);
  });

  it("hides trial and cancel sections when the report has neither", () => {
    renderPopup(root, { ...base, state: { status: "ready", report: SAMPLE_REPORT_GREEN } }, actions());
    expect(root.textContent).not.toContain("Remind me");
    expect(root.textContent).not.toContain("How to cancel");
    expect(root.textContent).toContain("No money traps found in the terms");
  });

  it("change strip (F-05)", () => {
    const report = { ...SAMPLE_REPORT_RED, changes: [{ policyUrl: "x", bullets: ["Price rises to $19.99.", "New early termination fee."], moneyRelevant: true }] };
    renderPopup(root, { ...base, state: { status: "ready", report } }, actions());
    expect(root.textContent).toContain("Terms changed since your last visit");
    expect(root.textContent).toContain("Price rises to $19.99.");
  });

  it("local fees and ticked boxes", () => {
    const fees = { currency: "USD", extrasTotal: 17.94, lines: [{ label: "Service fee", amount: 4.95, kind: "extra_fee" as const }, { label: "Protection plan", amount: 12.99, kind: "extra_fee" as const }, { label: "Total", amount: 164.25, kind: "total" as const }] };
    renderPopup(root, { ...base, state: { status: "ready", report: SAMPLE_REPORT_GREEN, fees, darkPatterns: [{ kind: "prechecked_addon", label: "Add 2-year Protection plan (+$12.99)" }] } }, actions());
    expect(root.textContent).toContain("Fees added at checkout");
    expect(root.textContent).toContain("2 extra fees add $17.94");
    expect(root.textContent).toContain("Ticked for you");
  });

  it("empty, checking and error states are written, not blank", () => {
    renderPopup(root, { ...base, state: { status: "idle" } }, actions());
    expect(root.textContent).toContain("Nothing to check on this page");
    renderPopup(root, { ...base, state: { status: "checking" } }, actions());
    expect(root.textContent).toContain("Reading the fine print");
    renderPopup(root, { ...base, state: { status: "error" } }, actions());
    expect(root.textContent).toContain("The Xcavate service didn't answer");
    expect(root.textContent).toContain("http://localhost:8787");
  });

  it("Scan button and settings call their actions", () => {
    const a = actions();
    renderPopup(root, { ...base, state: { status: "idle" } }, a);
    const scan = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Scan this page")!;
    scan.click();
    expect(a.scan).toHaveBeenCalled();
    const pause = root.querySelector<HTMLInputElement>("#set-pause")!;
    pause.click();
    expect(a.setPaused).toHaveBeenCalledWith(true);
    const enabled = root.querySelector<HTMLInputElement>("#set-enabled")!;
    enabled.click();
    expect(a.setEnabled).toHaveBeenCalledWith(false);
    root.querySelector<HTMLInputElement>("#set-api")!.setAttribute("value", "https://api.example");
    Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Save address")!.click();
    expect(a.saveApiBase).toHaveBeenCalled();
  });

  it("every control has an accessible name", () => {
    renderPopup(root, { ...base, state: { status: "ready", report: SAMPLE_REPORT_RED } }, actions());
    for (const input of Array.from(root.querySelectorAll("input"))) {
      expect(root.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    }
    for (const b of Array.from(root.querySelectorAll("button, a"))) expect((b.textContent ?? "").trim().length).toBeGreaterThan(0);
  });
});
