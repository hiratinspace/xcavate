import type { CancellationInfo, Report, TrialInfo } from "@xcavate/shared/core";

/**
 * F-03 trial reminder and F-04 cancellation draft (BUILD_PLAN 7.9). No extra permissions:
 * a Google Calendar template link, a .ics file, and a mailto: link the user sends themselves.
 */

function ymd(d: Date): string {
  return d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  c.setDate(c.getDate() + n);
  return c;
}

/** "streamnest.localhost:4000" + tab title "Checkout | StreamNest" → "StreamNest". */
export function storeName(domain: string, title = ""): string {
  const host = domain.split(":")[0].replace(/^www\./, "");
  const parts = host.split(".");
  const label = (parts.length > 2 && parts[parts.length - 1] !== "localhost" ? parts[parts.length - 2] : parts[0]) || host;
  const want = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const token of title.split(/[\s|·•:,–—\-]+/)) {
    if (token.toLowerCase().replace(/[^a-z0-9]/g, "") === want && want) return token.replace(/[^\p{L}\p{N}]/gu, "");
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface Reminder {
  date: Date;
  /** Days between the reminder and the first charge (2, or fewer for very short trials). */
  daysBefore: number;
  title: string;
  details: string;
  calendarUrl: string;
  ics: string;
}

/** Event dated today + lengthDays − 2 (all day). Undefined when there is no trial length. */
export function buildTrialReminder(
  trial: TrialInfo | undefined,
  store: string,
  policyUrl: string,
  today = new Date(),
): Reminder | undefined {
  if (!trial?.lengthDays || trial.lengthDays < 1) return undefined;
  // Two days before the charge, but never before today: short trials get a reminder today that
  // states the real number of days left.
  const offset = Math.max(0, trial.lengthDays - 2);
  const date = addDays(today, offset);
  const end = addDays(date, 1);
  const chargeDay = addDays(today, trial.lengthDays);
  const daysLeft = trial.lengthDays - offset;
  const when = daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
  const title = `${store} trial ends ${when}: cancel or keep?`;
  const price = trial.priceAfter
    ? `After the trial you pay ${trial.priceAfter}${trial.billingPeriod ? " per " + trial.billingPeriod : ""}.`
    : "After the trial you start paying.";
  const details = [
    `Your ${store} free trial ends on ${chargeDay.toDateString()}. ${price}`,
    "Cancel before then if you don't want to keep it.",
    policyUrl ? "Terms: " + policyUrl : "",
    "Reminder made by Xcavate.",
  ]
    .filter(Boolean)
    .join("\n");
  const calendarUrl =
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    "&text=" + encodeURIComponent(title) +
    "&dates=" + ymd(date) + "/" + ymd(end) +
    "&details=" + encodeURIComponent(details);
  return { date, daysBefore: daysLeft, title, details, calendarUrl, ics: buildIcs(title, details, date, end, today) };
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

const utf8 = new TextEncoder();

/**
 * Lines longer than 75 octets must be folded (RFC 5545 3.1). Counts UTF-8 bytes and only breaks
 * between code points; continuation lines start with a space, which counts towards their 75.
 */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = utf8.encode(ch).length;
    if (bytes + n > 75) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function buildIcs(title: string, details: string, date: Date, end: Date, stamp = new Date()): string {
  const dtstamp = stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Xcavate//Trial reminder//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    "UID:xcavate-" + ymd(date) + "-" + Math.abs(hashCode(title)) + "@xcavate.local",
    "DTSTAMP:" + dtstamp,
    "DTSTART;VALUE=DATE:" + ymd(date),
    "DTEND;VALUE=DATE:" + ymd(end),
    "SUMMARY:" + icsEscape(title),
    "DESCRIPTION:" + icsEscape(details),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:" + icsEscape(title),
    "TRIGGER:-PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** The policy a trial reminder should link to: the trial flag's policy, else the first one read. */
export function trialPolicyUrl(report: Report): string {
  const f = report.flags.find((x) => x.category === "trial_converts" && x.policyUrl);
  return f?.policyUrl ?? report.policies.find((p) => p.status === "analyzed")?.url ?? "";
}

export const METHOD_WORD: Record<CancellationInfo["method"], string> = {
  online: "Online, in your account",
  email: "By email",
  phone: "By phone only",
  mail: "By post only",
  unknown: "The terms don't say how",
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function contactHref(contact: string | undefined): string | undefined {
  if (!contact) return undefined;
  const email = contact.match(EMAIL_RE)?.[0];
  if (email) return "mailto:" + email;
  if (/^https?:\/\//i.test(contact.trim())) return contact.trim();
  const digits = contact.replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length >= 7) return "tel:" + digits;
  return undefined;
}

/** mailto: draft with subject "Cancellation request"; pre-fills the address when the policy gives one. */
export function buildCancellationMailto(store: string, cancellation: CancellationInfo | undefined): string {
  const to = cancellation?.contact?.match(EMAIL_RE)?.[0] ?? "";
  const body = [
    "Hello,",
    "",
    `Please cancel my ${store} subscription and any recurring charges linked to my account, effective immediately.`,
    "Please confirm by email once it is done, and confirm that I will not be charged again.",
    "",
    "Name:",
    "Account email:",
    "",
    "Thank you.",
  ].join("\n");
  return "mailto:" + to + "?subject=" + encodeURIComponent("Cancellation request") + "&body=" + encodeURIComponent(body);
}

const PERIOD_SUFFIX = { week: "/week", month: "/month", year: "/year" } as const;

/**
 * V-05 charge-date headline: "Free for 7 days, then $14.99/month from Sat, Nov 21".
 * The date is today + lengthDays in the browser's locale. Without a price: "Free for 7 days, then paid from …".
 */
export function chargeHeadline(trial: TrialInfo | undefined, today = new Date(), locale?: string): string | undefined {
  if (!trial?.lengthDays || trial.lengthDays < 1) return undefined;
  const charge = addDays(today, trial.lengthDays);
  const date = charge.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" });
  const days = trial.lengthDays === 1 ? "1 day" : trial.lengthDays + " days";
  const after = trial.priceAfter?.trim();
  // Some models already put the period in the price ("$14.99 per month"): don't add a second one.
  const hasPeriod = !!after && /\/|\bper\b|\b(a|each|every)\s+(week|month|year)|monthly|yearly|weekly|annual/i.test(after);
  const price = after ? after + (trial.billingPeriod && !hasPeriod ? PERIOD_SUFFIX[trial.billingPeriod] : "") : "paid";
  return `Free for ${days}, then ${price} from ${date}`;
}

/** Money categories first; arbitration and data sharing never make the card (the popup still lists them). */
const NOT_ON_CARD = new Set(["arbitration", "data_sharing"]);
export function cardFlags<T extends { category: string }>(flags: T[], max = 3): T[] {
  const money = (c: string) => (c === "missing_policy" ? 1 : 0);
  return flags
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !NOT_ON_CARD.has(f.category))
    .sort((a, b) => money(a.f.category) - money(b.f.category) || a.i - b.i)
    .slice(0, max)
    .map(({ f }) => f);
}

/** Split text into plain parts and http(s) URLs, so only real URLs become links (rights notes). */
export function linkParts(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i) });
    out.push({ text: m[0], href: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export const RIGHTS_LABEL = "Your rights (general information, not legal advice)";

const POLICY_WORD = { subscription: "subscription terms", refund: "refund policy", terms: "terms", privacy: "privacy policy", other: "this page" } as const;

/**
 * V-02 partial: name what we couldn't read, or say we only found a privacy policy, and point at Scan this page.
 */
export function partialNote(r: Report): string {
  const unreadable = r.policies.filter((p) => p.status === "unreadable");
  if (unreadable.length) {
    const names = andList(Array.from(new Set(unreadable.map((p) => POLICY_WORD[p.kind]))));
    return `Couldn't read the ${names}. Open ${unreadable.length === 1 ? "it" : "them"} and press Scan this page.`;
  }
  const read = Array.from(new Set(r.policies.filter((p) => p.status === "analyzed").map((p) => POLICY_WORD[p.kind])));
  const what = read.length ? "only the " + andList(read) : "no terms or refund policy";
  return `We found ${what}. If the site has terms or a refund policy, open it and press Scan this page.`;
}

/** ["terms", "refund policy"] → "terms and refund policy"; three or more → "a, b and c". */
export function andList(items: string[]): string {
  return items.length < 2 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

/** The verdict line's right-hand figure. */
export function countText(r: Report, shown: number): string {
  if (r.verdict === "green") return "None found";
  if (r.verdict === "unknown") return "Not read";
  if (r.verdict === "partial") {
    const total = r.policies.length;
    const read = r.policies.filter((p) => p.status === "analyzed").length;
    return total ? `${read} of ${total} read` : "";
  }
  return shown === 1 ? "1 thing" : shown + " things";
}
