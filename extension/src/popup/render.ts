import {
  CATEGORY_LABEL,
  DISCLAIMER,
  VERDICT_ICON,
  VERDICT_WORD,
  textFragmentUrl,
  verdictHeadline,
  type FeeSummary,
  type Flag,
  type Report,
  type Settings,
  type TabState,
} from "@xcavate/shared";
import {
  METHOD_WORD,
  buildCancellationMailto,
  buildTrialReminder,
  contactHref,
  storeName,
  trialPolicyUrl,
} from "../lib/actions";
import { formatMoney } from "../lib/money";

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
  downloadIcs(filename: string, ics: string): void;
}

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
        h("div", { class: "row" }, scan),
      ),
    );
  }

  parts.push(settingsSection(view, actions));
  parts.push(h("footer", {}, DISCLAIMER + " Only public policy text and the page address without its query are sent for analysis; fees and ticked boxes stay on your computer."));

  const wrap = h("div", { "data-verdict": verdict });
  wrap.append(...(parts.filter(Boolean) as Node[]));
  root.replaceChildren(wrap);

  // Trial + cancellation actions need the report; wire downloads after render.
  root.querySelectorAll<HTMLButtonElement>("button[data-ics]").forEach((b) => {
    b.addEventListener("click", () => actions.downloadIcs(b.dataset.filename ?? "reminder.ics", b.dataset.ics ?? ""));
  });
}

function header(view: PopupView, report: Report | undefined, status: string): HTMLElement {
  let glyph = "·";
  let word = "Xcavate";
  let headline = "Digs up the fine print before you pay";
  if (report) {
    glyph = VERDICT_ICON[report.verdict];
    word = VERDICT_WORD[report.verdict];
    // The shared headline caps at the card's 3 flags; the popup lists every flag, so count them all.
    headline =
      report.verdict === "red"
        ? report.flags.length === 1
          ? "1 thing to read before you pay"
          : report.flags.length + " things to read before you pay"
        : verdictHeadline(report);
  } else if (status === "checking") {
    glyph = "…";
    word = "Checking";
    headline = "Reading the fine print";
  } else if (status === "error") {
    glyph = "?";
    word = "No answer";
    headline = "Couldn't check this site right now";
  }
  const strata = h("div", { class: "strata", "aria-hidden": "true" }, h("span"), h("span"), h("span"), h("span"), h("span"));
  return h(
    "header",
    { class: "verdict" },
    strata,
    h(
      "div",
      { class: "verdict-body" },
      h("div", { class: "top" }, h("span", { class: "glyph", "aria-hidden": "true" }, glyph), h("span", { class: "word" }, word)),
      h("h1", { role: "status" }, headline),
      view.domain ? h("p", { class: "site" }, view.domain) : null,
    ),
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
          h("a", { class: "btn", href: reminder.calendarUrl, target: "_blank", rel: "noopener noreferrer" }, "Remind me 2 days before I'm charged"),
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
    tail.push(
      h(
        "section",
        {},
        h("h2", {}, "Policies read"),
        h(
          "ul",
          { class: "policies" },
          ...report.policies.map((p) =>
            h(
              "li",
              {},
              h("span", { class: "kind" }, KIND_WORD[p.kind]),
              h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, shortUrl(p.url)),
              h("span", { class: "status" }, p.status === "analyzed" ? "read" : "couldn't read"),
            ),
          ),
        ),
      ),
    );
  }
  return { lead, tail };
}

function flagItem(f: Flag): HTMLElement {
  const sev = h("span", { class: "sev", "data-sev": f.severity, "aria-hidden": "true" }, h("i"), h("i"), h("i"));
  const body = h(
    "div",
    {},
    h("h3", {}, f.title, h("small", { title: CATEGORY_LABEL[f.category] }, SEVERITY_WORD[f.severity])),
    h("p", { class: "sum" }, f.summary),
    f.costImpact ? h("p", { class: "cost" }, "Cost: " + f.costImpact) : null,
    f.quote ? h("blockquote", {}, f.quote) : null,
    f.quote && f.policyUrl
      ? h(
          "p",
          { class: "from" },
          h("a", { href: textFragmentUrl(f.policyUrl, f.quote), target: "_blank", rel: "noopener noreferrer" }, "See in policy"),
          " (" + shortUrl(f.policyUrl) + ")",
        )
      : null,
  );
  return h("li", { class: "flag", "data-sev": f.severity }, sev, body);
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
