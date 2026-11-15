import {
  CATEGORY_LABEL,
  DISCLAIMER,
  VERDICT_WORD,
  textFragmentUrl,
  verdictHeadline,
  type FeeSummary,
  type Flag,
  type Report,
  type Settings,
  type TabState,
} from "@xcavate/shared/core";
import {
  METHOD_WORD,
  buildCancellationMailto,
  buildTrialReminder,
  contactHref,
  countText,
  linkParts,
  partialNote,
  RIGHTS_LABEL,
  storeName,
  trialPolicyUrl,
} from "../lib/actions";
import { formatMoney } from "../lib/money";
import { icon, type IconName } from "../content/icons";

/** U-03 popup report, U-04 settings, F-03/F-04/F-05 sections. Pure DOM rendering, testable in jsdom. */

export interface PopupView {
  state?: TabState;
  domain?: string;
  tabTitle?: string;
  settings: Settings;
  today?: Date;
  scanning?: boolean;
  scanError?: string;
  settingsSaved?: boolean;
  /** Pages Chrome does not let extensions read (chrome://, the Web Store). */
  restricted?: boolean;
}

export interface PopupActions {
  scan(): void;
  setEnabled(v: boolean): void;
  setPaused(v: boolean): void;
  saveApiBase(v: string): void;
  /** V-06 "AI check" setting. Optional so older callers keep working. */
  setAiCheck?(v: boolean): void;
  /** Bring the card back on the page (after the shopper closed it). */
  showCard?(): void;
  downloadIcs(filename: string, ics: string): void;
}

export const PRIVACY_LINE =
  "Sent for analysis: the site's address (domain only) and the text of the policy pages it links to. Scan this page also sends the text and address of the page you scan, so Xcavate refuses to scan checkout pages. Fees and ticked boxes stay on your computer.";

/** Privacy line with the AI check off (V-06): the rules engine runs on this device only. */
export const PRIVACY_LINE_LOCAL =
  "AI check is off, so nothing is sent to the Xcavate service. Policy pages are fetched from the site and checked on your device. Fees and ticked boxes stay on your computer.";

/** V-06: one quiet line when the report shown was worked out on this device. */
export const LOCAL_CHECK_NOTE = {
  pending: "Checked on your device. The AI check is still running.",
  unavailable: "AI check unavailable, showing the on-device result.",
  off: "Checked on your device (AI check off).",
} as const;

const SEVERITY_WORD = { high: "High", medium: "Medium", low: "Low" } as const;
const KIND_WORD = { subscription: "Subscription", refund: "Refunds", terms: "Terms", privacy: "Privacy", other: "This page" } as const;

type Child = Node | string | null | undefined | false;

function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") e.className = String(v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export function renderPopup(root: HTMLElement, view: PopupView, actions: PopupActions): void {
  const { state } = view;
  const report = state?.report;
  const status = view.scanning ? "checking" : state?.status ?? "idle";
  const verdict = report ? report.verdict : status === "checking" ? "checking" : "none";

  // Local findings (fees, ticked boxes) sit right after the flags: they are money too.
  const local: HTMLElement[] = [];
  const fees = localFees(state?.fees);
  if (fees) local.push(fees);
  const dp = state?.darkPatterns ?? [];
  if (dp.length)
    local.push(
      h(
        "section",
        { class: "local" },
        h("h2", {}, dp.length === 1 ? "Ticked for you" : dp.length + " options ticked for you"),
        h("p", {}, "These were already selected when the page loaded. They're outlined on the page. Untick them if you don't want them."),
        h("ul", { class: "bullets" }, ...dp.map((d) => h("li", {}, d.label))),
      ),
    );

  const parts: Child[] = [];
  parts.push(header(view, report, status));

  if (view.scanError) parts.push(h("section", { class: "error-box", role: "alert" }, h("p", {}, view.scanError)));

  if (!view.settings.enabled) {
    parts.push(h("section", {}, h("p", {}, "Xcavate is switched off. Turn it on in Settings below to check checkout pages again.")));
  } else if (report) {
    const { lead, tail } = reportSections(report, view);
    if (state?.localCheck) parts.push(h("p", { class: "muted local-check" }, LOCAL_CHECK_NOTE[state.localCheck]));
    parts.push(...lead, ...local, ...tail);
    local.length = 0;
  } else if (status === "error") {
    parts.push(
      h(
        "section",
        { class: "error-box" },
        h("h2", {}, "The Xcavate service didn't answer"),
        h("p", {}, "Nothing on this page was changed. Check the service address in Settings (now " + view.settings.apiBase + "), then press Scan this page."),
      ),
    );
  } else if (status === "checking") {
    parts.push(h("section", {}, h("p", {}, "Finding this site's terms and reading them. This usually takes a few seconds.")));
  } else if (!view.restricted) {
    parts.push(
      h(
        "section",
        {},
        h("h2", {}, "Nothing to check on this page"),
        h("p", {}, "Xcavate opens by itself on checkout and sign-up pages."),
        h("p", {}, "Reading a refund policy or terms page right now? Press Scan this page to check it."),
      ),
    );
  }

  parts.push(...local);

  if (view.restricted) {
    parts.push(h("section", {}, h("p", { class: "muted" }, "Chrome doesn't let extensions read this page.")));
  } else {
    const scan = h("button", { class: "btn primary", type: "button", disabled: view.scanning || !view.settings.enabled }, view.scanning ? "Scanning…" : "Scan this page");
    scan.addEventListener("click", () => actions.scan());
    parts.push(
      h(
        "section",
        {},
        h("p", { class: "muted" }, "Have a policy page open that Xcavate couldn't fetch? Scan reads the page you see."),
        h("div", { class: "row" }, scan, ...showCardButton(state, actions)),
      ),
    );
  }

  parts.push(settingsSection(view, actions));
  parts.push(
    h(
      "footer",
      {},
      DISCLAIMER + " " + (view.settings.aiCheck ? PRIVACY_LINE : PRIVACY_LINE_LOCAL),
    ),
  );

  const wrap = h("div", { "data-verdict": verdict });
  wrap.append(...(parts.filter(Boolean) as Node[]));
  root.replaceChildren(wrap);

  // Trial + cancellation actions need the report; wire downloads after render.
  root.querySelectorAll<HTMLButtonElement>("button[data-ics]").forEach((b) => {
    b.addEventListener("click", () => actions.downloadIcs(b.dataset.filename ?? "reminder.ics", b.dataset.ics ?? ""));
  });
}

function header(view: PopupView, report: Report | undefined, status: string): HTMLElement {
  let mark: IconName | undefined;
  let word = "Xcavate";
  let count = "";
  let headline = "Digs up the fine print before you pay";
  if (report) {
    mark = report.verdict;
    word = VERDICT_WORD[report.verdict];
    count = countText(report, report.flags.length);
    // The shared headline caps at the card's 3 flags; the popup lists every flag, so count them all.
    headline =
      report.verdict === "red"
        ? report.flags.length === 1
          ? "1 thing to read before you pay"
          : report.flags.length + " things to read before you pay"
        : verdictHeadline(report);
  } else if (status === "checking") {
    mark = "checking";
    word = "Checking";
    headline = "Reading the fine print";
  } else if (status === "error") {
    mark = "unknown";
    word = "No answer";
    headline = "Couldn't check this site right now";
  }
  const glyph = mark ? h("span", { class: "glyph", "aria-hidden": "true", "data-icon": mark }) : null;
  if (glyph && mark) glyph.append(icon(document, mark));
  return h(
    "header",
    { class: "verdict" },
    h("div", { class: "top" }, h("span", { class: "title" }, "Terms Facts"), icon(document, "mark", "mark")),
    view.domain ? h("p", { class: "site" }, view.domain) : null,
    h("span", { class: "rule r10", "aria-hidden": "true" }),
    h("div", { class: "vline" }, glyph, h("span", { class: "word" }, word), count ? h("span", { class: "count" }, count) : null),
    h("span", { class: "rule r4", "aria-hidden": "true" }),
    h("h1", { role: "status" }, headline),
  );
}

function reportSections(report: Report, view: PopupView): { lead: HTMLElement[]; tail: HTMLElement[] } {
  const lead: HTMLElement[] = [];
  const out: HTMLElement[] = lead;
  const changes = report.changes?.filter((c) => c.bullets.length) ?? [];
  if (changes.length) {
    out.push(
      h(
        "section",
        { class: "change" },
        h("h2", {}, "Terms changed since your last visit"),
        ...changes.map((c) => h("ul", {}, ...c.bullets.map((b) => h("li", {}, b)))),
        changes.some((c) => c.moneyRelevant) ? h("p", { class: "muted" }, "At least one change affects what you pay.") : null,
      ),
    );
  }

  if (report.flags.length) {
    out.push(
      h(
        "section",
        { "aria-label": "Flags" },
        h("h2", {}, "What the terms say"),
        h("ul", { class: "flags" }, ...report.flags.map(flagItem)),
      ),
    );
  } else if (report.verdict === "green") {
    out.push(h("section", {}, h("p", {}, "No auto-renewals, refund limits, cancellation hoops or extra fees were found in the terms we read.")));
  }
  if (report.verdict === "partial") {
    out.push(
      h(
        "section",
        { class: "partial" },
        h("h2", {}, "Only partly read"),
        h("p", {}, partialNote(report)),
        h("p", { class: "muted" }, "No money traps in what we could read. That isn't the same as none."),
      ),
    );
  } else if (report.verdict === "unknown") {
    out.push(
      h(
        "section",
        {},
        h("h2", {}, "Couldn't read the terms"),
        h("p", {}, "The policy pages didn't load for us, or they build their text with scripts. Open the terms in this tab and press Scan this page."),
      ),
    );
  }

  const tail: HTMLElement[] = [];
  const store = storeName(report.domain, view.tabTitle);
  const reminder = buildTrialReminder(report.trial, store, trialPolicyUrl(report), view.today);
  if (reminder && report.trial) {
    const t = report.trial;
    tail.push(
      h(
        "section",
        {},
        h("h2", {}, "Free trial: " + t.lengthDays + " days"),
        h("p", {}, t.priceAfter ? "Then " + t.priceAfter + (t.billingPeriod ? " per " + t.billingPeriod : "") + ", charged automatically." : "Then you start paying."),
        h(
          "div",
          { class: "row" },
          h(
            "a",
            { class: "btn", href: reminder.calendarUrl, target: "_blank", rel: "noopener noreferrer" },
            reminder.daysBefore === 2 ? "Remind me 2 days before I'm charged" : "Remind me before I'm charged",
          ),
          h("button", { class: "btn", type: "button", "data-ics": reminder.ics, "data-filename": store.toLowerCase() + "-trial-reminder.ics" }, "Download .ics"),
        ),
        h("p", { class: "warn" }, "Reminder date: " + reminder.date.toDateString() + "."),
      ),
    );
  }

  const c = report.cancellation;
  if (c) {
    const facts = h("dl", { class: "facts" }, h("dt", {}, "How"), h("dd", {}, METHOD_WORD[c.method]));
    if (c.noticeDays !== undefined) facts.append(h("dt", {}, "Notice"), h("dd", {}, c.noticeDays + (c.noticeDays === 1 ? " day" : " days") + " before your next billing date"));
    if (c.contact) {
      const href = contactHref(c.contact);
      facts.append(h("dt", {}, "Contact"), h("dd", {}, href ? h("a", { href, target: href.startsWith("http") ? "_blank" : undefined, rel: "noopener noreferrer" }, c.contact) : c.contact));
    }
    tail.push(
      h(
        "section",
        {},
        h("h2", {}, "How to cancel"),
        facts,
        c.steps.length ? h("ol", { class: "steps" }, ...c.steps.map((s) => h("li", {}, s))) : null,
        h("div", { class: "row" }, h("a", { class: "btn", href: buildCancellationMailto(store, c) }, "Draft cancellation email")),
        c.method === "phone" || c.method === "mail"
          ? h("p", { class: "warn" }, "The terms ask you to cancel " + (c.method === "phone" ? "by phone" : "by post") + ". An email may not count on its own, so keep it as a written record.")
          : h("p", { class: "warn" }, "The draft opens in your mail app. Nothing is sent until you press send."),
      ),
    );
  }

  if (report.policies.length) {
    const read = report.policies.filter((p) => p.status === "analyzed").length;
    const unread = report.policies.length - read;
    tail.push(
      h(
        "section",
        {},
        h("h2", {}, "Policies read"),
        h(
          "p",
          { class: unread ? "warn coverage" : "muted coverage" },
          `Read ${read} of ${report.policies.length} ${report.policies.length === 1 ? "policy" : "policies"}.` +
            (unread ? " The verdict only covers what was read. Open the others and press Scan this page." : ""),
        ),
        h(
          "ul",
          { class: "policies" },
          ...report.policies.map((p) =>
            h(
              "li",
              {},
              h("span", { class: "kind" }, KIND_WORD[p.kind]),
              h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, shortUrl(p.url)),
              h("span", { class: "status" }, p.status === "analyzed" ? "read" : "couldn't read: open it, then Scan this page"),
            ),
          ),
        ),
      ),
    );
  }
  return { lead, tail };
}

function flagItem(f: Flag): HTMLElement {
  const body = h(
    "div",
    {},
    h("h3", {}, f.title, h("small", { title: CATEGORY_LABEL[f.category] }, SEVERITY_WORD[f.severity])),
    h("p", { class: "sum" }, f.summary),
    f.context ? h("p", { class: "ctx" }, f.context) : null,
    f.costImpact ? h("p", { class: "cost" }, "Cost: " + f.costImpact) : null,
    f.quote ? h("blockquote", {}, "\u201C" + f.quote + "\u201D") : null,
    f.quote && f.policyUrl
      ? h(
          "p",
          { class: "from" },
          h("a", { href: textFragmentUrl(f.policyUrl, f.quote), target: "_blank", rel: "noopener noreferrer" }, "See in policy"),
          " (" + shortUrl(f.policyUrl) + ")",
        )
      : null,
    f.rightsNote ? rightsBox(f.rightsNote) : null,
  );
  return h("li", { class: "flag", "data-sev": f.severity }, body);
}

function rightsBox(note: string): HTMLElement {
  const parts = linkParts(note).map((x) => (x.href ? h("a", { href: x.href, target: "_blank", rel: "noopener noreferrer" }, x.text) : x.text));
  return h("div", { class: "rights" }, h("p", { class: "rights-label" }, RIGHTS_LABEL), h("p", { class: "rights-text" }, ...parts));
}

function localFees(fees: FeeSummary | undefined): HTMLElement | null {
  if (!fees) return null;
  const extras = fees.lines.filter((l) => l.kind === "extra_fee");
  if (!extras.length) return null;
  const rows = fees.lines.map((l) =>
    h("tr", { class: l.kind === "extra_fee" ? "extra" : undefined }, h("td", {}, l.label), h("td", {}, formatMoney(l.amount, fees.currency))),
  );
  return h(
    "section",
    { class: "local" },
    h("h2", {}, "Fees added at checkout"),
    h("p", {}, (extras.length === 1 ? "1 extra fee adds " : extras.length + " extra fees add ") + formatMoney(fees.extrasTotal, fees.currency) + " on top of the price, shipping and tax."),
    h("table", { class: "fee-lines" }, h("tbody", {}, ...rows)),
  );
}

function settingsSection(view: PopupView, actions: PopupActions): HTMLElement {
  const enabled = h("input", { type: "checkbox", id: "set-enabled", checked: view.settings.enabled }) as HTMLInputElement;
  enabled.addEventListener("change", () => actions.setEnabled(enabled.checked));
  const paused = !!view.domain && view.settings.pausedDomains.includes(view.domain);
  const pause = h("input", { type: "checkbox", id: "set-pause", checked: paused, disabled: !view.domain }) as HTMLInputElement;
  pause.addEventListener("change", () => actions.setPaused(pause.checked));
  const ai = h("input", { type: "checkbox", id: "set-ai", checked: view.settings.aiCheck }) as HTMLInputElement;
  ai.addEventListener("change", () => actions.setAiCheck?.(ai.checked));
  const api = h("input", { type: "url", id: "set-api", value: view.settings.apiBase, spellcheck: "false" }) as HTMLInputElement;
  const save = h("button", { class: "btn", type: "button" }, "Save address");
  save.addEventListener("click", () => actions.saveApiBase(api.value));
  return h(
    "section",
    {},
    h(
      "details",
      { open: !view.settings.enabled || paused || undefined },
      h("summary", {}, "Settings"),
      h("div", { class: "setting" }, enabled, h("label", { for: "set-enabled" }, "Check checkout pages automatically")),
      h("div", { class: "setting" }, pause, h("label", { for: "set-pause" }, view.domain ? "Pause on " + view.domain : "Pause on this site")),
      h(
        "div",
        { class: "setting" },
        ai,
        h("label", { for: "set-ai" }, "AI check: also send the policy text to the Xcavate service for a second read (off: checked on your device only)"),
      ),
      h(
        "div",
        { class: "setting col" },
        h("label", { for: "set-api" }, "Xcavate service address"),
        api,
        h("div", { class: "row" }, save, view.settingsSaved ? h("span", { class: "saved", role: "status" }, "Saved") : null),
      ),
    ),
  );
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.host + (x.pathname === "/" ? "" : x.pathname);
  } catch {
    return u;
  }
}

/** "Show card on page": only when there is a verdict for this page and the popup can reach it. */
function showCardButton(state: TabState | undefined, actions: PopupActions): HTMLElement[] {
  if (!actions.showCard || !state?.report || state.status !== "ready") return [];
  const b = h("button", { class: "btn", type: "button" }, "Show card on page");
  b.addEventListener("click", () => actions.showCard?.());
  return [b];
}
