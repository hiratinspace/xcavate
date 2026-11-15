import { CATEGORY_LABEL, CATEGORY_MEANING, KEYWORDS, normalizeForMatch } from "@xcavate/shared";
import type { Category } from "@xcavate/shared";
import { isNegated } from "./rules.js";
import { NUM, findMoney, lpNormalize, toNumber } from "./textutil.js";

/**
 * Grounding for model free text (review item 3/4). The quote is verified elsewhere; these
 * checks keep everything else the model writes (amounts, contacts, numbers, reassurances)
 * tied to what the policy actually says.
 */

/** prompt.ts escapes "<" as "&lt;"; map it back so quotes match the real text. */
export function unsanitize(s: string): string {
  return s.replace(/&lt;/g, "<");
}

/** Normalised policy texts for repeated substring checks. */
export type Corpus = string[];

export function corpus(texts: string[]): Corpus {
  return texts.map(normalizeForMatch);
}

function inCorpus(c: Corpus, s: string): boolean {
  const n = normalizeForMatch(s);
  return n.length > 0 && c.some((t) => t.includes(n));
}

function digits(s: string): string {
  return s.replace(/\D/g, "");
}

/** Every money amount in `s` appears in the policy text (true when `s` names no amount). */
export function moneyGrounded(s: string, c: Corpus): boolean {
  return findMoney(s).every((m) => amountIn(c, m) || amountIn(c, m.replace(/\.00$/, "")));
}

/** The amount appears as a whole amount ("$1" does not match inside "$10" or "$1.50"). */
function amountIn(c: Corpus, amount: string): boolean {
  const n = normalizeForMatch(amount);
  if (!n) return false;
  const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\d]|[.,]\\d)");
  return c.some((t) => re.test(t));
}

const PHONE = /(?:\+?\d[\d ().-]{7,}\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL = /\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+/gi;

/** Phone numbers, emails and URLs in `s` all appear in the policy text. */
export function contactsGrounded(s: string, c: Corpus): boolean {
  const digitCorpus = c.map(digits);
  for (const p of s.match(PHONE) ?? []) {
    const d = digits(p);
    if (d.length >= 7 && !digitCorpus.some((t) => t.includes(d))) return false;
  }
  for (const e of [...(s.match(EMAIL) ?? []), ...(s.match(URL) ?? [])]) if (!inCorpus(c, e)) return false;
  return true;
}

/** A number of days stated in the text ("7-day", "seven days", "1 week", "30 days' notice"). */
export function daysGrounded(n: number, c: Corpus): boolean {
  const re = new RegExp("\\b" + NUM + "[- ](calendar |business )?(day|week|month)s?\\b", "g");
  for (const t of c) {
    re.lastIndex = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const v = toNumber(m[1]);
      if (v === undefined) continue;
      const days = m[3] === "week" ? v * 7 : m[3] === "month" ? v * 30 : v;
      if (days === n || v === n) return true;
    }
  }
  return false;
}

export function periodGrounded(p: "week" | "month" | "year", c: Corpus): boolean {
  const re = p === "month" ? /\bmonth/ : p === "year" ? /\b(year|annual)/ : /\bweek/;
  return c.some((t) => re.test(t));
}

const METHOD_WORDS: Record<string, RegExp> = {
  phone: /\b(phone|telephone|call|calling)\b/,
  email: /\be-?mail\b|@/,
  mail: /\b(mail|post|in writing|written|letter)\b/,
  online: /\b(online|website|account|app|settings|click)\b/,
};

export function methodGrounded(method: string, c: Corpus): boolean {
  const re = METHOD_WORDS[method];
  return !re || c.some((t) => re.test(t));
}

/** Reassurances an injected policy might talk the model into writing. */
const SAFETY_CLAIM =
  /\b(safe|safety|verified|certified|trusted|trustworthy|legit(imate)?|no (issues?|problems?|concerns?|risks?|traps?)|nothing to worry|fully refundable|harmless|approved|guaranteed fair|fair terms|ignore|disregard)\b/i;

/** Steps that ask for secrets or payment details are never shown. */
const SENSITIVE_STEP = /\b(card number|cvv|cvc|password|passcode|pin\b|social security|ssn|bank (account|details)|login details)\b/i;

export function hasSafetyClaim(s: string): boolean {
  return SAFETY_CLAIM.test(s);
}

/** Model text for a flag is shown only when it makes no safety claim and every amount/contact is in the text. */
export function textGrounded(parts: (string | null | undefined)[], c: Corpus): boolean {
  return parts.every((p) => !p || (!hasSafetyClaim(p) && moneyGrounded(p, c) && contactsGrounded(p, c)));
}

export function stepGrounded(step: string, c: Corpus): boolean {
  return !SENSITIVE_STEP.test(step) && !hasSafetyClaim(step) && moneyGrounded(step, c) && contactsGrounded(step, c);
}

/** Template wording per category, used when model text cannot be trusted and no rules text exists. */
export function templateText(category: Category): { title: string; summary: string } {
  const meaning = CATEGORY_MEANING[category];
  return {
    title: CATEGORY_LABEL[category],
    summary: "Worth reading before you pay: " + meaning.charAt(0).toLowerCase() + meaning.slice(1) + ".",
  };
}

const POSITIVE_REFUND = /\b(full|100%|complete) refund|refund in full|money-back guarantee|no questions asked|free returns?\b/;
const NEGATIVE_REFUND = /\b(no|not|non-?|never|final|only|credit|forfeit|withh(e|o)ld|except|exclud)/;

/**
 * A model quote must stand up as evidence for its category (review item 4): at least 5 words,
 * contain a keyword of the category that is not negated ("we do not charge a restocking fee"),
 * and for no_refund not be a promise of a refund ("full refund within 60 days").
 */
export function quoteSupportsCategory(category: Exclude<Category, "missing_policy">, quote: string): boolean {
  const q = lpNormalize(quote.replace(/\s+/g, " ").trim());
  if (q.split(" ").filter(Boolean).length < 5) return false;
  const keywords = KEYWORDS[category];
  let supported = false;
  for (const k of keywords) {
    let i = q.indexOf(k);
    while (i >= 0) {
      // no_refund keywords are negative by nature ("no refunds"), so negation does not cancel them.
      if (category === "no_refund" || !isNegated(q, i, i + k.length)) {
        supported = true;
        break;
      }
      i = q.indexOf(k, i + 1);
    }
    if (supported) break;
  }
  if (!supported) return false;
  if (category === "no_refund" && POSITIVE_REFUND.test(q) && !NEGATIVE_REFUND.test(q)) return false;
  return true;
}

/** A trial quote is attached only when it states the length and price the report shows. */
export function trialQuoteMatches(quote: string, lengthDays: number | undefined, priceAfter: string | undefined): boolean {
  const q = normalizeForMatch(quote);
  if (lengthDays !== undefined && !daysGrounded(lengthDays, [q])) return false;
  if (priceAfter && !q.includes(normalizeForMatch(priceAfter))) return false;
  return true;
}
