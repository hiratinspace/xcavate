import type { PageType } from "@xcavate/shared";
import { buttonText, cleanText } from "../lib/dom";
import { hasAmount } from "../lib/money";

/**
 * D-01 page classifier (BUILD_PLAN 7.1). Pure: reads the document, never changes it.
 * It checks that fields exist and never reads what anyone typed into a field.
 */

export interface Classification {
  pageType: PageType;
  score: number;
  signals: string[];
}

export const QUALIFY_SCORE = 5;

const PATH_STRONG = /checkout|payment|billing/;
const PATH_MEDIUM = /cart|basket|subscribe|signup|sign-up|register|join|plans|order/;
const CARD_NAME = /card|cvv|cvc|expir/i;
const PAY_IFRAME = /stripe|braintree|paypal|adyen/i;
const PAY_BUTTON = /place (your )?order|pay now|complete (purchase|order)|buy now|continue to payment|confirm (and|&) pay/i;
const SIGNUP_BUTTON = /start (your )?(free )?trial|subscribe|sign up|create account|join now/i;
const TOTAL = /\btotal\b/i;

const BUTTONS = 'button, input[type="submit"], input[type="button"], [role="button"]';

export function classify(doc: Document, url: string): Classification {
  const signals: string[] = [];
  let score = 0;
  let payment = false;
  const add = (points: number, name: string, isPayment = false) => {
    score += points;
    signals.push(name);
    if (isPayment) payment = true;
  };

  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    /* not a URL: path signals do not fire */
  }
  if (PATH_STRONG.test(path)) add(3, "path:checkout", true);
  if (PATH_MEDIUM.test(path)) add(2, "path:signup");

  if (hasCardField(doc)) add(4, "card-field", true);

  const iframes = Array.from(doc.querySelectorAll("iframe[src]"));
  if (iframes.some((f) => PAY_IFRAME.test(f.getAttribute("src") ?? ""))) add(3, "payment-iframe", true);

  const texts = Array.from(doc.querySelectorAll(BUTTONS))
    .slice(0, 300)
    .map(buttonText)
    .filter((t) => t.length > 0 && t.length <= 60);
  if (texts.some((t) => PAY_BUTTON.test(t))) add(3, "pay-button", true);
  if (texts.some((t) => SIGNUP_BUTTON.test(t))) add(3, "signup-button");

  if (hasTotalNearAmount(doc)) add(1, "total-amount");

  const pageType: PageType = score >= QUALIFY_SCORE ? (payment ? "checkout" : "signup") : "none";
  return { pageType, score, signals };
}

function hasCardField(doc: Document): boolean {
  if (doc.querySelector('input[autocomplete^="cc-"]')) return true;
  for (const el of Array.from(doc.querySelectorAll("input, select"))) {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "hidden" || type === "checkbox" || type === "radio" || type === "submit" || type === "button") continue;
    const ident = (el.getAttribute("name") ?? "") + " " + (el.getAttribute("id") ?? "");
    if (CARD_NAME.test(ident)) return true;
  }
  return false;
}

/**
 * "Total" within ~200 px of a currency amount. Parsed documents have no layout, so this uses
 * text proximity: a short element saying "total" whose own text or row holds an amount.
 */
function hasTotalNearAmount(doc: Document): boolean {
  const candidates = doc.querySelectorAll("td, th, dt, dd, span, div, p, li, strong, b, label");
  let checked = 0;
  for (const el of Array.from(candidates)) {
    if (++checked > 3000) break;
    if (el.children.length > 3) continue;
    const own = cleanText(el.textContent);
    if (own.length > 40 || !TOTAL.test(own)) continue;
    if (hasAmount(own)) return true;
    const row = el.parentElement;
    if (row) {
      const rowText = cleanText(row.textContent);
      if (rowText.length <= 200 && hasAmount(rowText)) return true;
    }
  }
  return false;
}
