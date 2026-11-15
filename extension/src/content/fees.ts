import type { FeeLine, FeeSummary } from "@xcavate/shared";
import { cleanText } from "../lib/dom";
import { formatMoney, parseAllAmounts } from "../lib/money";

/**
 * F-01 hidden fee detector (BUILD_PLAN 7.7). Local only: the result never leaves the browser.
 * Reads visible text of the order summary. Never reads form fields.
 */

const ROW_TAGS = "tr, li, div, p, dl, label, section, span, td, dd";
const MAX_ROW_CHARS = 90;

export function classifyFeeLabel(label: string): FeeLine["kind"] | undefined {
  const l = label.toLowerCase().trim();
  if (/^(order |grand |estimated )?total\b|amount due|due today|total due/.test(l)) return "total";
  if (/\bsub-?total\b|\bitems?\b/.test(l)) return "subtotal";
  if (/discount|promo|coupon|savings/.test(l)) return "discount";
  if (/\btax(es)?\b|\bvat\b|\bgst\b|\bhst\b/.test(l)) return "tax";
  if (/protection|insurance/.test(l)) return "extra_fee";
  if (/shipping|delivery|postage/.test(l)) return "shipping";
  if (/\bfees?\b|surcharge|handling|convenience|processing|service charge|\btip\b|warranty/.test(l)) return "extra_fee";
  return undefined;
}

interface Row {
  el: Element;
  label: string;
  amount: number;
  currency: string;
}

function rowOf(el: Element): Row | undefined {
  const text = cleanText(el.textContent);
  if (!text || text.length > MAX_ROW_CHARS) return undefined;
  const amounts = parseAllAmounts(text);
  if (amounts.length !== 1) return undefined;
  const a = amounts[0];
  const label = cleanText((text.slice(0, a.index) + " " + text.slice(a.index + a.raw.length)).replace(/[:()\[\]]+/g, " "));
  if (label.length < 2 || label.length > 60 || !/[a-z]/i.test(label)) return undefined;
  return { el, label, amount: a.amount, currency: a.currency };
}

/** Rows where a short label sits next to one currency amount, deepest element only. */
export function findAmountRows(doc: Document): Row[] {
  const rows: Row[] = [];
  const els = Array.from(doc.body?.querySelectorAll(ROW_TAGS) ?? []).slice(0, 5000);
  for (const el of els) {
    const r = rowOf(el);
    if (r) rows.push(r);
  }
  // <dt>Label</dt><dd>$1.00</dd> pairs are siblings, so pair them up explicitly.
  for (const dt of Array.from(doc.querySelectorAll("dt"))) {
    const dd = dt.nextElementSibling;
    if (!dd || dd.tagName !== "DD") continue;
    const label = cleanText(dt.textContent);
    const amounts = parseAllAmounts(cleanText(dd.textContent));
    if (label && amounts.length === 1 && label.length <= 60)
      rows.push({ el: dt, label, amount: amounts[0].amount, currency: amounts[0].currency });
  }
  // Keep the deepest match: drop a row whose element contains another matching row.
  const els2 = rows.map((r) => r.el);
  return rows.filter((r) => !els2.some((other) => other !== r.el && r.el.contains(other)));
}

/**
 * The order summary is the smallest ancestor of the total row that holds at least 3 amount rows.
 * Scoping to it keeps add-on labels elsewhere on the page (e.g. "Add protection (+$12.99)") from
 * being counted twice.
 */
function summaryRows(rows: Row[]): Row[] {
  const totalRow = rows.find((r) => classifyFeeLabel(r.label) === "total");
  if (!totalRow) return rows;
  let scope: Element | null = totalRow.el.parentElement;
  for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
    const inside = rows.filter((r) => scope!.contains(r.el));
    if (inside.length >= 3) return inside;
  }
  return rows;
}

/** Order-summary fees, or undefined when no total row exists (never guess). */
export function detectFees(doc: Document): FeeSummary | undefined {
  const lines: FeeLine[] = [];
  const seen = new Set<string>();
  let currency = "";
  let hasTotal = false;
  for (const r of summaryRows(findAmountRows(doc))) {
    const kind = classifyFeeLabel(r.label);
    if (!kind) continue;
    const key = r.label.toLowerCase() + "|" + r.amount;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === "total") {
      hasTotal = true;
      currency ||= r.currency;
    }
    lines.push({ label: r.label.slice(0, 80), amount: kind === "discount" ? -Math.abs(r.amount) : r.amount, kind });
  }
  if (!hasTotal) return undefined;
  if (!currency) currency = "USD";
  const extras = lines.filter((l) => l.kind === "extra_fee");
  const extrasTotal = Math.round(extras.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { currency, lines, extrasTotal };
}

/** "Service fee $4.95, Protection plan $12.99" */
export function describeExtras(fees: FeeSummary): string {
  return fees.lines
    .filter((l) => l.kind === "extra_fee")
    .map((l) => l.label + " " + formatMoney(l.amount, fees.currency))
    .join(", ");
}

export function extraFeeCount(fees: FeeSummary | undefined): number {
  return fees ? fees.lines.filter((l) => l.kind === "extra_fee").length : 0;
}
