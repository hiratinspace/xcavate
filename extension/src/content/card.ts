import {
  DISCLAIMER,
  VERDICT_ICON,
  VERDICT_WORD,
  verdictHeadline,
  type DarkPatternFinding,
  type FeeSummary,
  type Flag,
  type Report,
} from "@xcavate/shared/core";
import cardCss from "./card.css?inline";
import { describeExtras, extraFeeCount } from "./fees";

/**
 * U-01 checkout card (BUILD_PLAN 7.10). Fixed bottom-right, 340 px, inside a closed shadow root.
 * States: checking, red, yellow, green, unknown. Errors show no card at all.
 */

export const CARD_HOST_ID = "xcavate-card-host";
const MAX_FLAGS = 3;
const SEVERITY_WORD = { high: "High", medium: "Medium", low: "Low" } as const;

export type CardState = "hidden" | "checking" | "report";

export interface CardOptions {
  shadowMode?: ShadowRootMode;
  onDismiss?: () => void;
}

export interface LocalFindings {
  fees?: FeeSummary;
  darkPatterns?: DarkPatternFinding[];
}

const HOST_STYLE =
  "all: initial !important; position: fixed !important; right: 0 !important; bottom: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; display: block !important; pointer-events: auto !important; transform: none !important; filter: none !important; opacity: 1 !important; visibility: visible !important;";

export class Card {
  private host: HTMLElement;
  private root: ShadowRoot;
  private state: CardState = "hidden";
  private domain = "";
  private report: Report | undefined;
  private local: LocalFindings = {};
  private onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(private doc: Document, private opts: CardOptions = {}) {
    this.host = doc.createElement("xcavate-card");
    this.host.id = CARD_HOST_ID;
    this.host.setAttribute("style", HOST_STYLE);
    this.root = this.host.attachShadow({ mode: opts.shadowMode ?? "closed" });
  }

  get current(): CardState {
    return this.state;
  }

  /** Test hook: the shadow root (reachable from outside only in tests that pass shadowMode "open"). */
  get shadow(): ShadowRoot {
    return this.root;
  }

  showChecking(domain: string): void {
    this.domain = domain;
    this.report = undefined;
    this.state = "checking";
    this.render();
  }

  showReport(report: Report): void {
    this.report = report;
    this.domain = report.domain;
    this.state = "report";
    this.render();
  }

  setLocal(local: LocalFindings): void {
    this.local = local;
    if (this.state !== "hidden") this.render();
  }

  /** Remove the card without remembering anything (error state, navigation away). */
  hide(): void {
    this.state = "hidden";
    this.host.remove();
    this.doc.removeEventListener("keydown", this.onKey, true);
  }

  /** The user closed it. */
  dismiss(): void {
    this.hide();
    this.opts.onDismiss?.();
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.key !== "Escape" || this.state === "hidden") return;
    const active = this.doc.activeElement as HTMLElement | null;
    const inCard = active === this.host;
    const editing = !!active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable);
    if (inCard || !editing) this.dismiss();
  }

  private render(): void {
    const d = this.doc;
    const verdict = this.state === "checking" ? "checking" : this.report?.verdict ?? "unknown";
    const fresh = !this.host.isConnected;

    const card = el(d, "section", "card");
    card.dataset.verdict = verdict;
    card.setAttribute("aria-label", "Xcavate fine print check");
    if (fresh) card.setAttribute("data-enter", "");

    const core = el(d, "div", "core");
    core.setAttribute("aria-hidden", "true");
    for (const c of ["l-v", "l1", "l2", "l3", "l4"]) core.appendChild(el(d, "span", c));
    card.appendChild(core);

    const body = el(d, "div", "body");
    card.appendChild(body);

    const head = el(d, "div", "head");
    const top = el(d, "div", "top");
    const glyph = el(d, "span", "glyph", this.state === "checking" ? "…" : VERDICT_ICON[verdict as keyof typeof VERDICT_ICON]);
    glyph.setAttribute("aria-hidden", "true");
    top.appendChild(glyph);
    const word = this.state === "checking" ? "Checking the fine print" : VERDICT_WORD[this.report!.verdict];
    top.appendChild(el(d, "span", "word", word));
    const close = el(d, "button", "close", "×");
    close.setAttribute("type", "button");
    close.setAttribute("aria-label", "Close Xcavate card");
    close.addEventListener("click", () => this.dismiss());
    top.appendChild(close);
    head.appendChild(top);

    const headline =
      this.state === "checking"
        ? "Reading this site's terms before you pay…"
        : verdictHeadline(this.report!);
    const h = el(d, "p", "headline", headline);
    h.setAttribute("role", "status");
    h.setAttribute("aria-live", "polite");
    head.appendChild(h);
    if (this.domain) head.appendChild(el(d, "p", "site", this.domain));
    body.appendChild(head);

    if (this.state === "report" && this.report) {
      const flags = this.report.flags.slice(0, MAX_FLAGS);
      if (flags.length) {
        const list = el(d, "ul", "flags");
        list.setAttribute("aria-label", "Things to read");
        for (const f of flags) list.appendChild(this.flagItem(f));
        body.appendChild(list);
      } else if (this.report.verdict === "green") {
        body.appendChild(el(d, "p", "empty", "We read " + policyCount(this.report) + " and found no auto-renewals, refund limits or extra fees."));
      }
      const cov = coverage(this.report);
      if (cov) body.appendChild(el(d, "p", "note coverage", cov));
      const changes = this.report.changes?.filter((c) => c.bullets.length) ?? [];
      if (changes.length) {
        const p = el(d, "p", "note change");
        p.appendChild(el(d, "b", "", "Terms changed since your last visit. "));
        p.appendChild(d.createTextNode(changes[0].bullets[0]));
        body.appendChild(p);
      }
    }

    const nFees = extraFeeCount(this.local.fees);
    if (nFees > 0 && this.local.fees) {
      const p = el(d, "p", "note local");
      p.appendChild(el(d, "b", "", "Fees added at checkout: "));
      p.appendChild(d.createTextNode(describeExtras(this.local.fees)));
      body.appendChild(p);
    }
    const dp = this.local.darkPatterns ?? [];
    if (dp.length) {
      const p = el(d, "p", "note local");
      const what = dp.length === 1 ? "1 option was ticked for you" : dp.length + " options were ticked for you";
      p.appendChild(el(d, "b", "", what + ". "));
      p.appendChild(d.createTextNode("Outlined on the page: " + dp.map((x) => shortLabel(x.label)).join("; ")));
      body.appendChild(p);
    }

    const foot = el(d, "div", "foot");
    if (this.state === "report") {
      const more = el(d, "button", "more", "See all");
      more.setAttribute("type", "button");
      more.setAttribute("aria-expanded", "false");
      const hint = el(d, "p", "hint", "Click the Xcavate button in your browser toolbar to see every flag and the exact sentence it came from.");
      hint.id = "xc-hint";
      hint.hidden = true;
      more.setAttribute("aria-controls", "xc-hint");
      more.addEventListener("click", () => {
        hint.hidden = !hint.hidden;
        more.setAttribute("aria-expanded", String(!hint.hidden));
      });
      foot.appendChild(more);
      foot.appendChild(el(d, "p", "disclaimer", DISCLAIMER));
      foot.appendChild(hint);
    } else {
      foot.appendChild(el(d, "p", "disclaimer", DISCLAIMER));
    }
    body.appendChild(foot);

    const style = d.createElement("style");
    style.textContent = cardCss;
    this.root.replaceChildren(style, card);
    if (fresh) {
      (d.documentElement ?? d.body).appendChild(this.host);
      d.addEventListener("keydown", this.onKey, true);
    }
  }

  private flagItem(f: Flag): HTMLElement {
    const d = this.doc;
    const li = el(d, "li", "flag");
    const sev = el(d, "span", "sev");
    sev.dataset.sev = f.severity;
    sev.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) sev.appendChild(d.createElement("i"));
    li.appendChild(sev);
    const text = el(d, "div", "");
    const title = el(d, "p", "flag-title", f.title);
    title.appendChild(el(d, "small", "", SEVERITY_WORD[f.severity]));
    text.appendChild(title);
    text.appendChild(el(d, "p", "flag-sum", f.summary));
    li.appendChild(text);
    return li;
  }
}

function el(d: Document, tag: string, cls: string, text?: string): HTMLElement {
  const e = d.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const KIND_WORD = { subscription: "subscription terms", refund: "refund policy", terms: "terms", privacy: "privacy policy", other: "this page" } as const;

/** "Read 2 of 3 policies. Couldn't read the terms: open them and press Scan this page." (only when something was unreadable) */
export function coverage(r: Report): string | undefined {
  const total = r.policies.length;
  const unreadable = r.policies.filter((p) => p.status === "unreadable");
  if (!total || !unreadable.length) return undefined;
  const read = total - unreadable.length;
  const names = Array.from(new Set(unreadable.map((p) => KIND_WORD[p.kind]))).join(", ");
  return `Read ${read} of ${total} ${total === 1 ? "policy" : "policies"}. Couldn't read the ${names}: open ${unreadable.length === 1 ? "it" : "them"} and press Scan this page.`;
}

function policyCount(r: Report): string {
  const n = r.policies.filter((p) => p.status === "analyzed").length;
  return n === 1 ? "1 policy" : n + " policies";
}

function shortLabel(label: string): string {
  return label.length > 60 ? label.slice(0, 57).trimEnd() + "…" : label;
}
