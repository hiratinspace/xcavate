import { beforeEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../fixtures/load";
import { DarkPatternMarkers, MARKS_HOST_ID, findDarkPatterns } from "../src/content/darkPatterns";
import { setLiveDocument } from "./helpers";

function inputSnapshot(doc: Document) {
  return Array.from(doc.querySelectorAll("input")).map((i) => ({
    html: i.outerHTML,
    checked: i.checked,
    defaultChecked: i.defaultChecked,
    disabled: i.disabled,
  }));
}

/** Page DOM outside our overlay host. */
function pageHtml(doc: Document) {
  const clone = doc.documentElement.cloneNode(true) as Element;
  clone.querySelector("#" + MARKS_HOST_ID)?.remove();
  return clone.outerHTML;
}

describe("findDarkPatterns", () => {
  beforeEach(() => setLiveDocument("<body></body>"));

  it("finds pre-checked add-ons with their price", () => {
    setLiveDocument(`<body>
      <label><input type="checkbox" checked> Add shipping protection ($3.50)</label>
      <label><input type="checkbox"> Add gift wrap ($4.00)</label>
      <label><input type="checkbox" checked> I am over 18</label></body>`);
    const hits = findDarkPatterns(document);
    expect(hits.map((h) => h.finding)).toEqual([{ kind: "prechecked_addon", label: "Add shipping protection ($3.50)" }]);
    expect(hits[0].note).toBe("Pre-checked: adds $3.50");
  });

  it("finds a pre-selected subscription only when a one-time option exists", () => {
    setLiveDocument(`<body>
      <input type="radio" name="a" id="a1" checked><label for="a1">Monthly auto-ship</label>
      <input type="radio" name="a" id="a2"><label for="a2">One-time purchase</label>
      <input type="radio" name="b" id="b1" checked><label for="b1">Monthly plan</label>
      <input type="radio" name="b" id="b2"><label for="b2">Yearly plan</label></body>`);
    expect(findDarkPatterns(document).map((h) => h.finding.kind)).toEqual(["preselected_subscription"]);
  });

  it("gadgetly: pre-checked protection plan and pre-selected auto-ship", () => {
    setLiveDocument(loadFixture("gadgetly", "checkout"));
    const hits = findDarkPatterns(document);
    expect(hits.map((h) => h.finding.kind)).toEqual(["prechecked_addon", "preselected_subscription"]);
    expect(hits[0].finding.label).toContain("Protection plan");
    expect(hits[0].note).toBe("Pre-checked: adds $12.99");
  });

  it("fairbox: nothing (newsletter box is not pre-checked)", () => {
    setLiveDocument(loadFixture("fairbox", "checkout"));
    expect(findDarkPatterns(document)).toEqual([]);
  });
});

describe("DarkPatternMarkers", () => {
  it("outlines without modifying any input or page element, and removes the outline when unticked", () => {
    setLiveDocument(loadFixture("gadgetly", "checkout"));
    const before = inputSnapshot(document);
    const pageBefore = pageHtml(document);

    const markers = new DarkPatternMarkers(document, "open");
    markers.mark(findDarkPatterns(document));
    expect(markers.count).toBe(2);
    expect(document.getElementById(MARKS_HOST_ID)).not.toBeNull();
    const tags = Array.from(markers.shadow.querySelectorAll(".tag")).map((t) => t.textContent);
    expect(tags).toContain("Pre-checked: adds $12.99");
    const css = markers.shadow.querySelector("style")!.textContent!;
    expect(css).toMatch(/border: 2px solid/);

    // Nothing on the page changed: same inputs, same states, same markup.
    expect(inputSnapshot(document)).toEqual(before);
    expect(pageHtml(document)).toBe(pageBefore);

    // The shopper unticks the protection plan: its outline goes, the box stays as they left it.
    const box = document.getElementById("protection") as HTMLInputElement;
    box.click();
    expect(box.checked).toBe(false);
    expect(markers.count).toBe(1);
    expect(box.checked).toBe(false);

    // Choosing one-time removes the subscription outline and the overlay host.
    (document.getElementById("tips-once") as HTMLInputElement).click();
    expect(markers.count).toBe(0);
    expect(document.getElementById(MARKS_HOST_ID)).toBeNull();
  });

  it("reports the remaining findings when the shopper unticks one, so the card row doesn't go stale", () => {
    setLiveDocument(loadFixture("gadgetly", "checkout"));
    const markers = new DarkPatternMarkers(document, "open");
    const updates: unknown[][] = [];
    markers.onUpdate = (rest) => updates.push(rest);
    const hits = findDarkPatterns(document);
    markers.mark(hits);
    const protection = hits.find((h) => h.input.id === "protection")!.finding;

    (document.getElementById("protection") as HTMLInputElement).click();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveLength(hits.length - 1);
    expect(updates[0]).not.toContain(protection);

    (document.getElementById("tips-once") as HTMLInputElement).click();
    expect(updates.at(-1)).toEqual([]);
  });
});
