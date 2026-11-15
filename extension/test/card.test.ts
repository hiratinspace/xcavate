import { DISCLAIMER, SAMPLE_REPORT_GREEN, SAMPLE_REPORT_RED, type Report } from "@xcavate/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CARD_HOST_ID, Card } from "../src/content/card";
import { setLiveDocument } from "./helpers";

const text = (c: Card) => c.shadow.textContent ?? "";

describe("Card", () => {
  beforeEach(() => setLiveDocument("<body><input id='field'></body>"));

  it("shows a checking state with role=status", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showChecking("shop.example");
    expect(document.getElementById(CARD_HOST_ID)).not.toBeNull();
    expect(card.shadow.querySelector('[role="status"]')?.textContent).toMatch(/Reading this site's terms/);
    expect(card.shadow.querySelector(".card")?.getAttribute("data-verdict")).toBe("checking");
    expect(text(card)).toContain(DISCLAIMER);
  });

  it("renders a red report: icon + word + headline, at most 3 flags with severity words", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport({ ...SAMPLE_REPORT_RED, trial: undefined });
    const root = card.shadow;
    expect(root.querySelector(".card")?.getAttribute("data-verdict")).toBe("red");
    expect(root.querySelector(".glyph")?.textContent).toBe("!");
    expect(root.querySelector(".word")?.textContent).toBe("Read first");
    expect(root.querySelector(".headline")?.textContent).toBe("3 things to read before you pay");
    expect(root.querySelectorAll(".flag").length).toBe(3);
    expect(root.querySelector(".flag-title small")?.textContent).toBe("High");
    expect(text(card)).toContain("See all");
    expect(text(card)).toContain(DISCLAIMER);
  });

  it("renders green and unknown wording", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(SAMPLE_REPORT_GREEN);
    expect(text(card)).toContain("No money traps found in the terms");
    expect(text(card)).toContain("Looks fair");
    const unknown: Report = { ...SAMPLE_REPORT_GREEN, verdict: "unknown", policies: [] };
    card.showReport(unknown);
    expect(text(card)).toContain("Scan this page");
    expect(card.shadow.querySelector(".glyph")?.textContent).toBe("?");
  });

  it("shows fees, dark patterns and the change strip", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport({ ...SAMPLE_REPORT_RED, changes: [{ policyUrl: "x", bullets: ["Price rises to $19.99 a month."], moneyRelevant: true }] });
    card.setLocal({
      fees: { currency: "USD", extrasTotal: 4.95, lines: [{ label: "Service fee", amount: 4.95, kind: "extra_fee" }, { label: "Total", amount: 10, kind: "total" }] },
      darkPatterns: [{ kind: "prechecked_addon", label: "Add 2-year Protection plan (+$12.99)" }],
    });
    const t = text(card);
    expect(t).toContain("Fees added at checkout: Service fee $4.95");
    expect(t).toContain("1 option was ticked for you");
    expect(t).toContain("Terms changed since your last visit. Price rises to $19.99 a month.");
  });

  it("shows no fee row when there are no extra fees", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(SAMPLE_REPORT_GREEN);
    card.setLocal({ fees: { currency: "USD", extrasTotal: 0, lines: [{ label: "Total", amount: 10, kind: "total" }] }, darkPatterns: [] });
    expect(text(card)).not.toContain("Fees added");
  });

  it("close button and Escape dismiss it and report the dismissal", () => {
    const onDismiss = vi.fn();
    const card = new Card(document, { shadowMode: "open", onDismiss });
    card.showReport(SAMPLE_REPORT_RED);
    (card.shadow.querySelector(".close") as HTMLButtonElement).click();
    expect(document.getElementById(CARD_HOST_ID)).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);

    card.showReport(SAMPLE_REPORT_RED);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card.current).toBe("hidden");
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("Escape while typing in a page field does not dismiss", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(SAMPLE_REPORT_RED);
    (document.getElementById("field") as HTMLInputElement).focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card.current).toBe("report");
  });

  it("host is isolated: closed shadow by default, inline !important styles, max z-index", () => {
    const card = new Card(document);
    card.showChecking("x");
    const host = document.getElementById(CARD_HOST_ID)!;
    expect(host.shadowRoot).toBeNull(); // closed
    const style = host.getAttribute("style")!;
    expect(style).toContain("z-index: 2147483647 !important");
    expect(style).toContain("position: fixed !important");
  });

  it("hide() removes it silently (error state)", () => {
    const onDismiss = vi.fn();
    const card = new Card(document, { shadowMode: "open", onDismiss });
    card.showChecking("x");
    card.hide();
    expect(document.getElementById(CARD_HOST_ID)).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("renders untrusted report text as text, never as HTML", () => {
    const card = new Card(document, { shadowMode: "open" });
    const evil = { ...SAMPLE_REPORT_RED, trial: undefined, flags: [{ ...SAMPLE_REPORT_RED.flags[0], title: "<img src=x onerror=alert(1)>" }] };
    card.showReport(evil);
    expect(card.shadow.querySelector("img")).toBeNull();
    expect(text(card)).toContain("<img src=x onerror=alert(1)>");
  });
});
