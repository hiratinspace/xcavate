import {
  DISCLAIMER,
  textFragmentUrl,
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
import { buildTrialReminder, cardFlags, chargeHeadline, linkParts, partialNote, RIGHTS_LABEL, storeName, trialPolicyUrl } from "../lib/actions";

/**
 * U-01 checkout card (BUILD_PLAN 7.10). Fixed bottom-right, 340 px, inside a closed shadow root.
 * States: checking, red, yellow, green, partial, unknown. Errors show no card at all.
 * With a known trial length the headline is the charge date (V-05) and the card offers a reminder.
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
  /** The headline node last rendered; kept across a same-verdict update so nothing is re-announced. */
  private headlineEl: HTMLElement | undefined;
  private inPlace = false;
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
    this.inPlace = false;
    this.domain = domain;
    this.report = undefined;
    this.state = "checking";
    this.render();
  }

  /**
   * Show a report. When a report with the same verdict is already shown (V-06: the on-device
   * verdict, then the backend's), the card updates in place: same headline node, no re-announcement.
   * A different verdict re-renders with the normal role=status announcement.
   */
  showReport(report: Report): void {
    this.inPlace = this.state === "report" && this.host.isConnected && this.report?.verdict === report.verdict;
    this.report = report;
    this.domain = report.domain;
    this.state = "report";
    this.render();
  }

  setLocal(local: LocalFindings): void {
    this.local = local;
    if (this.state === "hidden") return;
    this.inPlace = this.host.isConnected; // same verdict and headline: keep the live region quiet
    this.render();
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

    const r = this.state === "report" ? this.report : undefined;
    const shown = r ? cardFlags(r.flags, MAX_FLAGS) : [];
    const charge = r ? chargeHeadline(r.trial) : undefined;
    const headline = !r
      ? "Reading this site's terms before you pay…"
      : charge ?? verdictHeadline({ verdict: r.verdict, flags: shown.length ? shown : r.flags });
    const prev = this.inPlace ? this.headlineEl : undefined;
    this.inPlace = false;
    let h: HTMLElement;
    if (prev) {
      h = prev;
      if (h.textContent !== headline) h.textContent = headline;
    } else {
      h = el(d, "p", "headline", headline);
      h.setAttribute("role", "status");
      h.setAttribute("aria-live", "polite");
    }
    this.headlineEl = h;
    head.appendChild(h);
    if (this.domain) head.appendChild(el(d, "p", "site", this.domain));
    body.appendChild(head);

    if (r) {
      let rest = shown;
      if (charge) {
        const quoted = this.trialBlock(body, r, shown);
        rest = shown.filter((f) => f !== quoted);
      }
      if (rest.length) {
        const list = el(d, "ul", "flags");
        list.setAttribute("aria-label", charge ? "More to read" : "Things to read");
        for (const f of rest) list.appendChild(this.flagItem(f));
        body.appendChild(list);
      } else if (r.verdict === "green" && !charge) {
        body.appendChild(el(d, "p", "empty", "We read " + policyCount(r) + " and found no auto-renewals, refund limits or extra fees."));
      }
      const cov = r.verdict === "partial" ? partialNote(r) : coverage(r);
      if (cov) body.appendChild(el(d, "p", "note coverage", cov));
      const changes = r.changes?.filter((c) => c.bullets.length) ?? [];
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
    if (f.context) text.appendChild(el(d, "p", "flag-ctx", f.context));
    if (f.rightsNote) text.appendChild(rightsBox(d, f.rightsNote));
    li.appendChild(text);
    return li;
  }

  /**
   * V-05: reminder actions and one quoted sentence under the charge-date headline.
   * Returns the card flag whose quote is shown, so it is not repeated below.
   */
  private trialBlock(body: HTMLElement, r: Report, shown: Flag[]): Flag | undefined {
    const d = this.doc;
    const wrap = el(d, "div", "trial");
    const policyUrl = trialPolicyUrl(r);
    const reminder = buildTrialReminder(r.trial, storeName(r.domain, d.title), policyUrl);
    if (reminder) {
      const acts = el(d, "div", "remind");
      acts.setAttribute("role", "group");
      acts.setAttribute("aria-label", "Trial reminder");
      const days = reminder.daysBefore === 1 ? "1 day" : reminder.daysBefore + " days";
      const cal = el(d, "a", "btn primary", `Remind me ${days} before`) as HTMLAnchorElement;
      cal.href = reminder.calendarUrl;
      cal.target = "_blank";
      cal.rel = "noopener noreferrer";
      cal.setAttribute("aria-label", `Remind me ${days} before the first charge, in Google Calendar (opens a new tab)`);
      acts.appendChild(cal);
      const ics = el(d, "a", "btn", ".ics file") as HTMLAnchorElement;
      ics.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(reminder.ics);
      ics.download = "xcavate-trial-reminder.ics";
      ics.setAttribute("aria-label", "Download the reminder as an .ics file for any calendar app");
      acts.appendChild(ics);
      wrap.appendChild(acts);
    }

    const trialFlag = shown.find((f) => f.category === "trial_converts");
    const quote = r.trial?.quote || trialFlag?.quote || shown[0]?.quote;
    const from = r.trial?.quote ? trialFlag : trialFlag ?? shown[0];
    const url = from?.policyUrl || policyUrl;
    if (quote) {
      const bq = el(d, "blockquote", "quote");
      bq.appendChild(el(d, "p", "", "\u201C" + quote + "\u201D"));
      const link = url ? textFragmentUrl(url, quote) : "";
      if (link) {
        const a = el(d, "a", "see", "See in policy") as HTMLAnchorElement;
        a.href = link;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        bq.appendChild(a);
      }
      wrap.appendChild(bq);
    }
    body.appendChild(wrap);
    return quote ? from : undefined;
  }
}

/** "Your rights (general information, not legal advice)" box. Only real http(s) URLs become links. */
export function rightsBox(d: Document, note: string): HTMLElement {
  const box = el(d, "div", "rights");
  box.appendChild(el(d, "p", "rights-label", RIGHTS_LABEL));
  const p = el(d, "p", "rights-text");
  for (const part of linkParts(note)) {
    if (part.href) {
      const a = el(d, "a", "", part.text) as HTMLAnchorElement;
      a.href = part.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      p.appendChild(a);
    } else p.appendChild(d.createTextNode(part.text));
  }
  box.appendChild(p);
  return box;
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
