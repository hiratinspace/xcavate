import type { DarkPatternFinding } from "@xcavate/shared";
import { controlLabel, visualTarget } from "../lib/dom";
import { formatMoney, parseAmount } from "../lib/money";
import { ACCENT_AMBER, INK } from "./tokens";

/**
 * F-02 dark pattern spotter (BUILD_PLAN 7.8). Local only.
 * It reads whether boxes are checked and never changes them: the outline is drawn in our own
 * overlay layer, so no page element (and no input) is ever modified.
 */

const ADDON = /protection|insurance|warranty|donat|gift wrap|priority|membership|newsletter|subscribe/i;
const SUBSCRIPTION = /subscribe|auto.?ship|recurring|monthly/i;
const ONE_TIME = /one.?time|single/i;

export interface DarkPatternHit {
  finding: DarkPatternFinding;
  input: HTMLInputElement;
  target: Element;
  note: string;
}

export function findDarkPatterns(doc: Document): DarkPatternHit[] {
  const hits: DarkPatternHit[] = [];
  for (const input of Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
    if (!input.checked) continue;
    const label = controlLabel(input);
    if (!ADDON.test(label)) continue;
    const amount = parseAmount(label);
    const note = amount ? "Pre-checked: adds " + formatMoney(amount.amount, amount.currency) : "Pre-checked add-on";
    hits.push({ finding: { kind: "prechecked_addon", label: label.slice(0, 120) }, input, target: visualTarget(input), note });
  }
  for (const input of Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="radio"]'))) {
    if (!input.checked) continue;
    const label = controlLabel(input);
    if (!SUBSCRIPTION.test(label)) continue;
    const name = input.getAttribute("name");
    if (!name) continue;
    const group = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(
      (r) => r !== input && r.getAttribute("name") === name,
    );
    if (!group.some((r) => ONE_TIME.test(controlLabel(r)))) continue;
    hits.push({
      finding: { kind: "preselected_subscription", label: label.slice(0, 120) },
      input,
      target: visualTarget(input),
      note: "Pre-selected: repeat subscription",
    });
  }
  return hits;
}

export const MARKS_HOST_ID = "xcavate-marks-host";

/** Draws amber outlines + labels over hits, in a closed shadow root layered over the page. */
export class DarkPatternMarkers {
  private host: HTMLElement;
  private root: ShadowRoot;
  private marks = new Map<HTMLInputElement, { hit: DarkPatternHit; box: HTMLElement }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private onChange = (e: Event) => this.handleChange(e);
  private onResize = () => this.position();

  constructor(private doc: Document, shadowMode: ShadowRootMode = "closed") {
    this.host = doc.createElement("xcavate-marks");
    this.host.id = MARKS_HOST_ID;
    this.host.setAttribute(
      "style",
      "all: initial !important; position: absolute !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483646 !important; pointer-events: none !important; display: block !important;",
    );
    this.root = this.host.attachShadow({ mode: shadowMode });
    const style = doc.createElement("style");
    style.textContent = `
      .mark { position: absolute; box-sizing: border-box; border: 2px solid ${ACCENT_AMBER}; border-radius: 3px; pointer-events: none; }
      .tag { position: absolute; left: -2px; bottom: 100%; margin-bottom: 3px; white-space: nowrap;
        font: 600 11px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: 0.01em;
        color: #FFF4D6; background: ${INK}; padding: 2px 6px 2px 5px; border-radius: 3px; border-left: 3px solid ${ACCENT_AMBER}; }`;
    this.root.appendChild(style);
  }

  get count(): number {
    return this.marks.size;
  }

  mark(hits: DarkPatternHit[]): void {
    for (const hit of hits) {
      if (this.marks.has(hit.input)) continue;
      const box = this.doc.createElement("div");
      box.className = "mark";
      const tag = this.doc.createElement("span");
      tag.className = "tag";
      tag.textContent = hit.note;
      box.appendChild(tag);
      this.root.appendChild(box);
      this.marks.set(hit.input, { hit, box });
    }
    if (this.marks.size && !this.host.isConnected) {
      this.doc.documentElement.appendChild(this.host);
      this.doc.addEventListener("change", this.onChange, { capture: true, passive: true });
      this.doc.defaultView?.addEventListener("resize", this.onResize, { passive: true });
      this.timer = setInterval(this.onResize, 1500);
    }
    this.position();
  }

  private handleChange(e: Event): void {
    for (const [input, { hit, box }] of this.marks) {
      const affected = e.target === input || (hit.finding.kind === "preselected_subscription" && (e.target as Element)?.getAttribute?.("name") === input.getAttribute("name"));
      if (affected && !input.checked) {
        box.remove();
        this.marks.delete(input);
      }
    }
    if (!this.marks.size) this.destroy();
  }

  private position(): void {
    const view = this.doc.defaultView;
    const sx = view?.scrollX ?? 0;
    const sy = view?.scrollY ?? 0;
    for (const [input, { hit, box }] of this.marks) {
      if (!input.isConnected) {
        box.remove();
        this.marks.delete(input);
        continue;
      }
      const r = hit.target.getBoundingClientRect();
      box.style.left = r.left + sx - 4 + "px";
      box.style.top = r.top + sy - 4 + "px";
      box.style.width = r.width + 8 + "px";
      box.style.height = r.height + 8 + "px";
      box.style.display = r.width || r.height ? "block" : "none";
    }
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.doc.removeEventListener("change", this.onChange, { capture: true });
    this.doc.defaultView?.removeEventListener("resize", this.onResize);
    for (const { box } of this.marks.values()) box.remove();
    this.marks.clear();
    this.host.remove();
  }

  /** Test hook: the shadow root (only reachable when created with mode "open"). */
  get shadow(): ShadowRoot {
    return this.root;
  }
}
