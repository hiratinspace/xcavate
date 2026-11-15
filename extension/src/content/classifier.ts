import type { PageType } from "@xcavate/shared/core";
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

// Whole path segments only (an optional extension like .html/.aspx is allowed), so "/border-crisis",
// "/cartoons", "/joint-pain" or "/billing-scandal" don't count.
const PATH_STRONG = new Set(["checkout", "payment", "billing", "pay"]);
const PATH_MEDIUM = new Set(["cart", "basket", "subscribe", "signup", "sign-up", "sign_up", "register", "join", "plans", "order"]);
/** Card-field names/ids: cc-*, cardnumber, card-number/card_no, cvv, cvc, csc, exp/expiry(-date|-month|-year). */
const CARD_NAME = /^(cc[-_ ]?(name|number|num|exp[a-z-]*|csc|cvc|cvv|type)|card[-_ ]?(number|no|num)|cvv\d?|cvc\d?|csc|exp(iry|iration)?([-_ ]?(date|month|year|mm|yy|yyyy))?)$/i;
/** A price that reads like a plan: "$14.99/month", "€9 per year", "then $5 a week", "free trial … $0". */
const PLAN_PRICE = /([$€£¥₹]\s?\d[\d.,]*\s*(\/|per|a|every|each)\s*(mo|month|yr|year|week|wk))|(\d+[- ]day (free )?trial)/i;
const PAY_IFRAME = /stripe|braintree|paypal|adyen/i;
const PAY_BUTTON = /place (your )?order|pay now|complete (purchase|order)|buy now|continue to payment|confirm (and|&) pay/i;
const SIGNUP_BUTTON = /start (your )?(free )?trial|subscribe|sign up|create account|join now/i;
const TOTAL = /\btotal\b/i;
/** V-07 pricing-page call to action: "Start your free trial", "Try it free", "Start trial", "Get started free". */
const TRIAL_CTA = /start (your |my |a )?(free )?trial|try (it )?(for )?free|get started (for )?free/i;

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

  let segments: string[] = [];
  try {
    segments = new URL(url).pathname
      .toLowerCase()
      .split("/")
      .map((seg) => seg.replace(/\.(html?|php|aspx?|jsp)$/, ""))
      .filter(Boolean);
  } catch {
    /* not a URL: path signals do not fire */
  }
  if (segments.some((seg) => PATH_STRONG.has(seg))) add(3, "path:checkout", true);
  const pathSignup = segments.some((seg) => PATH_MEDIUM.has(seg));
  if (pathSignup) add(2, "path:signup");

  if (hasCardField(doc)) add(4, "card-field", true);

  const iframes = Array.from(doc.querySelectorAll("iframe[src]"));
  if (iframes.some((f) => PAY_IFRAME.test(f.getAttribute("src") ?? ""))) add(3, "payment-iframe", true);

  const texts = Array.from(doc.querySelectorAll(BUTTONS))
    .slice(0, 300)
    .map(buttonText)
    .filter((t) => t.length > 0 && t.length <= 60);
  if (texts.some((t) => PAY_BUTTON.test(t))) add(3, "pay-button", true);

  const total = hasTotalNearAmount(doc);
  if (total) add(1, "total-amount");

  // A bare "Subscribe" or "Sign up" (newsletters, comment accounts) is not a purchase. The signup
  // button only counts next to a money signal: a payment signal, a total, a sign-up path, or a plan price.
  const planPrice = PLAN_PRICE.test(pageText(doc));
  // V-07: plans/pricing pages. A trial CTA (buttons or short links) next to a recurring price or an
  // "N-day trial" qualifies on its own. Long articles are left out, so a paywall banner on a news
  // story doesn't turn the story into a sign-up page.
  const trialCta = planPrice && !articleLike(doc) && hasTrialCta(doc, texts);
  if ((trialCta || texts.some((t) => SIGNUP_BUTTON.test(t))) && (payment || total || pathSignup || planPrice)) add(3, "signup-button");
  if (trialCta) add(2, "plan-price");

  const pageType: PageType = score >= QUALIFY_SCORE ? (payment ? "checkout" : "signup") : "none";
  return { pageType, score, signals };
}

function hasTrialCta(doc: Document, buttonTexts: string[]): boolean {
  if (buttonTexts.some((t) => TRIAL_CTA.test(t))) return true;
  return Array.from(doc.querySelectorAll("a[href]"))
    .slice(0, 500)
    .some((a) => {
      const t = cleanText(a.textContent ?? "");
      return t.length > 0 && t.length <= 40 && TRIAL_CTA.test(t);
    });
}

function articleLike(doc: Document): boolean {
  const a = doc.querySelector("article");
  return !!a && cleanText(a.textContent ?? "").length > 1500;
}

function pageText(doc: Document): string {
  return (doc.body?.textContent ?? "").slice(0, 50_000);
}

function hasCardField(doc: Document): boolean {
  if (doc.querySelector('input[autocomplete^="cc-"]')) return true;
  for (const el of Array.from(doc.querySelectorAll("input, select"))) {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "hidden" || type === "checkbox" || type === "radio" || type === "submit" || type === "button") continue;
    for (const attr of ["name", "id"]) {
      const v = (el.getAttribute(attr) ?? "").trim();
      if (v && CARD_NAME.test(v)) return true;
    }
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
