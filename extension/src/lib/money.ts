/**
 * Currency amount parsing shared by the classifier, fee detector and dark-pattern labels.
 * Handles "$1,299.00", "€12,50", "1.299,00 €", "£4", "-$5.00", "USD 12.00".
 */

const SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" };
const CODES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "INR", "CHF", "NZD"];

const NUM = String.raw`\d{1,3}(?:[.,  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const SYM = String.raw`[$€£¥₹]|(?:${CODES.join("|")})\b`;
/** One amount with its currency marker before or after the number. */
const AMOUNT_SRC = String.raw`([-−–]\s*)?(?:(?:[A-Z]{1,2})?(${SYM})\s?([-−–]\s*)?(${NUM})|(${NUM})\s?(${SYM}))`;
export const AMOUNT_RE = new RegExp(AMOUNT_SRC, "u");
const AMOUNT_RE_G = new RegExp(AMOUNT_SRC, "gu");

export interface ParsedAmount {
  amount: number;
  currency: string;
  raw: string;
  index: number;
}

/** Turn a number string with either decimal convention into a number. */
export function parseNumber(s: string): number {
  const t = s.replace(/[\s ]/g, "");
  const last = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
  let intPart = t;
  let frac = "";
  if (last >= 0) {
    const decimals = t.length - last - 1;
    // A separator followed by 1-2 digits at the end is a decimal mark; 3 digits means thousands.
    if (decimals > 0 && decimals <= 2) {
      intPart = t.slice(0, last);
      frac = t.slice(last + 1);
    }
  }
  intPart = intPart.replace(/[.,]/g, "");
  const n = Number(intPart + (frac ? "." + frac : ""));
  return Number.isFinite(n) ? n : NaN;
}

function currencyOf(marker: string): string {
  return SYMBOLS[marker] ?? marker.toUpperCase();
}

function toParsed(m: RegExpMatchArray): ParsedAmount {
  const negative = Boolean(m[1] || m[3]);
  const marker = m[2] ?? m[6] ?? "";
  const num = m[4] ?? m[5] ?? "0";
  const amount = parseNumber(num) * (negative ? -1 : 1);
  return { amount, currency: currencyOf(marker), raw: m[0].trim(), index: m.index ?? 0 };
}

/** First currency amount in a string, or undefined. */
export function parseAmount(text: string): ParsedAmount | undefined {
  const m = AMOUNT_RE.exec(text);
  return m ? toParsed(m) : undefined;
}

export function parseAllAmounts(text: string): ParsedAmount[] {
  return Array.from(text.matchAll(AMOUNT_RE_G), toParsed);
}

export function hasAmount(text: string): boolean {
  return AMOUNT_RE.test(text);
}

/** Display format, e.g. (4.95, "USD") → "$4.95". */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return amount.toFixed(2) + " " + currency;
  }
}
