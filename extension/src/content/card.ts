import {
  DISCLAIMER,
  textFragmentUrl,
  VERDICT_WORD,
  verdictHeadline,
  type DarkPatternFinding,
  type FeeSummary,
  type Flag,
  type Report,
} from "@xcavate/shared/core";
import cardCss from "./card.css?inline";
import { icon } from "./icons";
import { describeExtras, extraFeeCount } from "./fees";
import { buildTrialReminder, cardFlags, chargeHeadline, countText, linkParts, partialNote, RIGHTS_LABEL, storeName, trialPolicyUrl } from "../lib/actions";

/**
 * U-01 checkout card (BUILD_PLAN 7.10). Fixed bottom corner, inside a closed shadow root.
 * States: checking, red, yellow, green, partial, unknown. Errors show no card at all.
 * With a known trial length the headline is the charge date (V-05) and the card offers a reminder.
 *
 * It starts compact (verdict, headline, "Show details", disclaimer: under 140 px tall) so it never
 * hides a price or a pay button; the shopper expands it, or moves it to the other side. Both
 * choices survive re-renders and are reported through `onPrefsChange` so the content script can
 * keep them for the session.
 */

export const CARD_HOST_ID = "xcavate-card-host";
const MAX_FLAGS = 3;
const SEVERITY_WORD = { high: "High", medium: "Medium", low: "Low" } as const;

export type CardState = "hidden" | "checking" | "report";

export type CardSide = "right" | "left";

export interface CardPrefs {
  /** Details open. Default false: the card starts compact. */
  expanded: boolean;
  /** Which bottom corner. Default "right". */
  side: CardSide;
}

export interface CardOptions {
  shadowMode?: ShadowRootMode;
  onDismiss?: () => void;
  /** Starting preferences (for example the ones remembered for this browser session). */
  prefs?: Partial<CardPrefs>;
  /** Called whenever the shopper expands/collapses the card or moves it. */
  onPrefsChange?: (prefs: CardPrefs) => void;
}

export interface LocalFindings {
  fees?: FeeSummary;
  darkPatterns?: DarkPatternFinding[];
}

const HOST_STYLE =
  "all: initial !important; position: fixed !important; right: 0 !important; bottom: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; display: block !important; pointer-events: auto !important; transform: none !important; filter: none !important; opacity: 1 !important; visibility: visible !important;";

let fontsRequested = false;

/**
 * Libre Franklin (OFL, bundled in fonts/) for the card. Loaded as bytes through the extension, so a
 * page's font-src CSP can't block it; until it arrives the card falls back to Helvetica/Arial.
 */
function loadCardFonts(doc: Document): void {
  if (fontsRequested) return;
  fontsRequested = true;
  const rt = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } }).chrome?.runtime;
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (!rt?.getURL || !fonts || typeof FontFace === "undefined") return;
  const faces: [string, FontFaceDescriptors][] = [
    ["fonts/libre-franklin-latin.woff2", { weight: "400 900", style: "normal" }],
    ["fonts/libre-franklin-italic-latin.woff2", { weight: "400 900", style: "italic" }],
  ];
  for (const [path, desc] of faces) {
    fetch(rt.getURL(path))
      .then((res) => res.arrayBuffer())
      .then((buf) => new FontFace("Xcavate Franklin", buf, desc).load())
      .then((face) => fonts.add(face))
      .catch(() => undefined);
  }
}

export class Card {
  private host: HTMLElement;
  private root: ShadowRoot;
  private state: CardState = "hidden";
  private domain = "";
  /** The verdict on screen is the on-device quick check and the AI review is still running. */
  private provisional = false;
  private report: Report | undefined;
  private local: LocalFindings = {};
  /** The headline node last rendered; kept across a same-verdict update so nothing is re-announced. */
  private headlineEl: HTMLElement | undefined;
  private inPlace = false;
  private prefs: CardPrefs;
  private cardEl: HTMLElement | undefined;
  private onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(private doc: Document, private opts: CardOptions = {}) {
    this.prefs = { expanded: opts.prefs?.expanded ?? false, side: opts.prefs?.side === "left" ? "left" : "right" };
    this.host = doc.createElement("xcavate-card");
    this.host.id = CARD_HOST_ID;
    this.host.setAttribute("style", HOST_STYLE);
    this.root = this.host.attachShadow({ mode: opts.shadowMode ?? "closed" });
    loadCardFonts(doc);
  }

  get current(): CardState {
    return this.state;
  }

  /** Test hook: the shadow root (reachable from outside only in tests that pass shadowMode "open"). */
  get shadow(): ShadowRoot {
    return this.root;
  }

  /** Current preferences (expanded, side). */
  get preferences(): CardPrefs {
    return { ...this.prefs };
  }

  /**
   * Apply preferences loaded later (for example from session storage), without telling
   * `onPrefsChange` and without re-announcing anything.
   */
  setPrefs(prefs: Partial<CardPrefs>): void {
    if (prefs.expanded !== undefined) this.prefs.expanded = prefs.expanded;
    if (prefs.side === "left" || prefs.side === "right") this.prefs.side = prefs.side;
    this.applyPrefs();
  }

  showChecking(domain: string): void {
    this.inPlace = false;
    this.provisional = false;
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
  showReport(report: Report, opts: { provisional?: boolean } = {}): void {
    this.inPlace = this.state === "report" && this.host.isConnected && this.report?.verdict === report.verdict;
    this.provisional = opts.provisional === true;
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
    // Only when the shopper is inside the card: pages use Escape for their own menus, modals and
    // cookie banners, and a dismissal hides the card for the whole site in this tab.
    if (this.doc.activeElement === this.host) this.dismiss();
  }

  private render(): void {
    const d = this.doc;
    const verdict = this.state === "checking" ? "checking" : this.report?.verdict ?? "unknown";
    const fresh = !this.host.isConnected;
    // Keyboard focus survives a re-render (the backend report replacing the on-device one): every
    // focusable control carries a stable data-xc-key, restored after the new tree is in place.
    const focusKey = (this.root.activeElement as HTMLElement | null)?.dataset?.xcKey;

    const card = el(d, "section", "card");
    card.dataset.verdict = verdict;
    card.setAttribute("aria-label", "Xcavate fine print check");
    if (fresh) card.setAttribute("data-enter", "");
    this.cardEl = card;

    const body = el(d, "div", "body");
    card.appendChild(body);

    const r = this.state === "report" ? this.report : undefined;
    const shown = r ? cardFlags(r.flags, MAX_FLAGS) : [];
    const charge = r ? chargeHeadline(r.trial) : undefined;

    // Title row, like the top of a nutrition label: "Terms Facts", the mark, then move and close.
    const head = el(d, "div", "head");
    const top = el(d, "div", "top");
    top.appendChild(el(d, "span", "title", "Terms Facts"));
    top.appendChild(icon(d, "mark", "mark"));
    top.appendChild(el(d, "span", "gap"));
    const move = button(d, "move", "", "move");
    move.addEventListener("click", () => this.updatePrefs({ side: this.prefs.side === "right" ? "left" : "right" }));
    top.appendChild(move);
    const close = button(d, "close", "", "close");
    close.appendChild(icon(d, "close"));
    close.setAttribute("aria-label", "Close Xcavate card");
    close.title = "Close";
    close.addEventListener("click", () => this.dismiss());
    top.appendChild(close);
    head.appendChild(top);
    if (this.domain) head.appendChild(el(d, "p", "site", this.provisional && this.state === "report" ? this.domain + " · Quick check, AI review running" : this.domain));
    head.appendChild(rule(d, "r10"));

    // Verdict line: the label's "Calories" row. Word left, count right in the state colour.
    const vline = el(d, "div", "vline");
    const glyph = el(d, "span", "glyph");
    glyph.dataset.icon = verdict;
    glyph.setAttribute("aria-hidden", "true");
    glyph.appendChild(icon(d, verdict));
    vline.appendChild(glyph);
    const word = this.state === "checking" ? "Checking the terms" : VERDICT_WORD[this.report!.verdict];
    vline.appendChild(el(d, "span", "word", word));
    const count = r ? countText(r, shown.length) : "";
    if (count) vline.appendChild(el(d, "span", "count", count));
    head.appendChild(vline);
    head.appendChild(rule(d, "r4"));

    const headline = !r
      ? "Reading this site's terms before you pay\u2026"
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
    head.appendChild(rule(d, "r1"));
    body.appendChild(head);

    // Always visible, in both states: the trial reminder (the action that matters), the toggle
    // and the disclaimer. Everything else lives in the details below, hidden with CSS while
    // compact, so the toggle never rebuilds the tree (focus and the live region stay put).
    const bar = el(d, "div", "bar");
    const details = el(d, "div", "details");
    details.id = "xc-details";

    if (r) {
      let rest = shown;
      if (charge) {
        const quoted = this.trialBlock(bar, details, r, shown);
        rest = shown.filter((f) => f !== quoted);
      }
      if (rest.length) {
        const list = el(d, "ul", "flags");
        list.setAttribute("aria-label", charge ? "More to read" : "Things to read");
        rest.forEach((f, i) => list.appendChild(this.flagItem(f, i)));
        details.appendChild(list);
      } else if (r.verdict === "green" && !charge) {
        details.appendChild(el(d, "p", "empty", "We read " + policyCount(r) + " and found no auto-renewals, refund limits or extra fees."));
      }
      const cov = r.verdict === "partial" ? partialNote(r) : coverage(r);
      if (cov) details.appendChild(el(d, "p", "note coverage", cov));
      const changes = r.changes?.filter((c) => c.bullets.length) ?? [];
      if (changes.length) {
        const p = el(d, "p", "note change");
        p.appendChild(el(d, "b", "", "Terms changed since your last visit. "));
        p.appendChild(d.createTextNode(changes[0].bullets[0]));
        details.appendChild(p);
      }
    }

    const nFees = extraFeeCount(this.local.fees);
    if (nFees > 0 && this.local.fees) {
      const p = el(d, "p", "note local");
      p.appendChild(el(d, "b", "", "Fees added at checkout: "));
      p.appendChild(d.createTextNode(describeExtras(this.local.fees)));
      details.appendChild(p);
    }
    const dp = this.local.darkPatterns ?? [];
    if (dp.length) {
      const p = el(d, "p", "note local");
      const what = dp.length === 1 ? "1 option was ticked for you" : dp.length + " options were ticked for you";
      p.appendChild(el(d, "b", "", what + ". "));
      p.appendChild(d.createTextNode("Outlined on the page: " + dp.map((x) => shortLabel(x.label)).join("; ")));
      details.appendChild(p);
    }

    if (this.state === "report") {
      const foot = el(d, "div", "foot");
      const more = button(d, "more", "See all", "more");
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
      foot.appendChild(hint);
      details.appendChild(foot);
    }
    const hasDetails = details.childNodes.length > 0;
    body.appendChild(bar);
    if (hasDetails) body.appendChild(details);
    if (hasDetails) {
      const toggle = button(d, "toggle", "", "toggle");
      toggle.setAttribute("aria-controls", "xc-details");
      toggle.addEventListener("click", () => this.updatePrefs({ expanded: !this.prefs.expanded }));
      bar.appendChild(toggle);
    }
    bar.appendChild(el(d, "p", "disclaimer", DISCLAIMER));

    const style = d.createElement("style");
    style.textContent = cardCss;
    this.root.replaceChildren(style, card);
    this.applyPrefs();
    if (fresh) {
      (d.documentElement ?? d.body).appendChild(this.host);
      d.addEventListener("keydown", this.onKey, true);
    }
    if (focusKey) {
      const target =
        this.root.querySelector<HTMLElement>(`[data-xc-key="${focusKey}"]`) ?? this.root.querySelector<HTMLElement>('[data-xc-key="toggle"]');
      target?.focus({ preventScroll: true });
    }
  }

  private updatePrefs(next: Partial<CardPrefs>): void {
    this.setPrefs(next);
    this.opts.onPrefsChange?.({ ...this.prefs });
  }

  /** Reflect expanded/side on the current tree without rebuilding it. */
  private applyPrefs(): void {
    const card = this.cardEl;
    if (!card) return;
    const { expanded, side } = this.prefs;
    card.dataset.expanded = String(expanded);
    card.dataset.side = side;
    const toggle = card.querySelector<HTMLElement>(".toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.textContent = expanded ? "Hide details" : "Show details";
    }
    const move = card.querySelector<HTMLElement>(".move");
    if (move) {
      const to = side === "right" ? "left" : "right";
      move.replaceChildren(icon(this.doc, side === "right" ? "left" : "right"));
      move.setAttribute("aria-label", `Move the Xcavate card to the ${to} side`);
      move.title = `Move to the ${to}`;
    }
  }

  private flagItem(f: Flag, index: number): HTMLElement {
    const d = this.doc;
    const li = el(d, "li", "flag");
    li.dataset.sev = f.severity;
    const title = el(d, "p", "flag-title", f.title);
    title.appendChild(el(d, "small", "", SEVERITY_WORD[f.severity]));
    li.appendChild(title);
    li.appendChild(el(d, "p", "flag-sum", f.summary));
    if (f.context) li.appendChild(el(d, "p", "flag-ctx", f.context));
    if (f.quote) li.appendChild(quoteNote(d, f.quote, f.policyUrl, "see-" + index));
    if (f.rightsNote) li.appendChild(rightsBox(d, f.rightsNote, "rights-" + index));
    return li;
  }

  /**
   * V-05: reminder actions and one quoted sentence under the charge-date headline.
   * Returns the card flag whose quote is shown, so it is not repeated below.
   */
  private trialBlock(bar: HTMLElement, details: HTMLElement, r: Report, shown: Flag[]): Flag | undefined {
    const d = this.doc;
    const wrap = el(d, "div", "trial trial-quote");
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
      cal.dataset.xcKey = "remind";
      acts.appendChild(cal);
      bar.appendChild(acts);
      const more = el(d, "div", "remind remind-more");
      const ics = el(d, "a", "btn", ".ics file") as HTMLAnchorElement;
      ics.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(reminder.ics);
      ics.download = "xcavate-trial-reminder.ics";
      ics.setAttribute("aria-label", "Download the reminder as an .ics file for any calendar app");
      ics.dataset.xcKey = "ics";
      more.appendChild(d.createTextNode("Other calendar: "));
      more.appendChild(ics);
      wrap.appendChild(more);
    }

    const trialFlag = shown.find((f) => f.category === "trial_converts");
    const quote = r.trial?.quote || trialFlag?.quote || shown[0]?.quote;
    const from = r.trial?.quote ? trialFlag : trialFlag ?? shown[0];
    const url = from?.policyUrl || policyUrl;
    if (quote) wrap.prepend(quoteNote(d, quote, url, "see"));
    if (wrap.childNodes.length) details.appendChild(wrap);
    return quote ? from : undefined;
  }
}

/** "Your rights (general information, not legal advice)" box. Only real http(s) URLs become links. */
export function rightsBox(d: Document, note: string, keyPrefix?: string): HTMLElement {
  const box = el(d, "div", "rights");
  box.appendChild(el(d, "p", "rights-label", RIGHTS_LABEL));
  const p = el(d, "p", "rights-text");
  let n = 0;
  for (const part of linkParts(note)) {
    if (part.href) {
      const a = el(d, "a", "", part.text) as HTMLAnchorElement;
      a.href = part.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      if (keyPrefix) a.dataset.xcKey = keyPrefix + "-" + n++;
      p.appendChild(a);
    } else p.appendChild(d.createTextNode(part.text));
  }
  box.appendChild(p);
  return box;
}

/** The proof, set like a label footnote: the exact sentence, then a link to it in the policy. */
function quoteNote(d: Document, quote: string, url: string | undefined, key: string): HTMLElement {
  const bq = el(d, "blockquote", "quote");
  bq.appendChild(el(d, "p", "", "\u201C" + quote + "\u201D"));
  const link = url ? textFragmentUrl(url, quote) : "";
  if (link) {
    const a = el(d, "a", "see", "See in policy") as HTMLAnchorElement;
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.dataset.xcKey = key;
    bq.appendChild(a);
  }
  return bq;
}

function rule(d: Document, weight: "r10" | "r4" | "r1"): HTMLElement {
  const r = el(d, "span", "rule " + weight);
  r.setAttribute("aria-hidden", "true");
  return r;
}

function button(d: Document, cls: string, text: string, key: string): HTMLElement {
  const b = el(d, "button", cls, text);
  b.setAttribute("type", "button");
  b.dataset.xcKey = key;
  return b;
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
