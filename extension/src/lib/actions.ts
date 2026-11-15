import type { CancellationInfo, Report, TrialInfo } from "@xcavate/shared";

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
  const date = addDays(today, Math.max(0, trial.lengthDays - 2));
  const end = addDays(date, 1);
  const chargeDay = addDays(today, trial.lengthDays);
  const title = `${store} trial ends in 2 days: cancel or keep?`;
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
  return { date, title, details, calendarUrl, ics: buildIcs(title, details, date, end, today) };
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 octets must be folded (RFC 5545 3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = " " + rest.slice(74);
  }
  out.push(rest);
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
