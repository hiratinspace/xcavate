import type { PageType } from "@xcavate/shared/core";
import { buttonText, cleanText } from "../lib/dom";
import { hasAmount, parseAllAmounts } from "../lib/money";

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
const PATH_STRONG = new Set(["checkout", "checkouts", "payment", "billing", "pay"]);
const PATH_MEDIUM = new Set(["subscribe", "signup", "sign-up", "sign_up", "register", "join", "plans", "order"]);
/** Plan and pricing pages (V-07 + direction v3). They score, but do not stand in for a price. */
const PATH_PLAN = new Set([
  "pricing", "plan", "plans", "premium", "membership", "memberships", "subscription", "subscriptions",
  "trial", "free-trial", "freetrial", "start-trial", "upgrade", "planform",
]);
/** A cart: the shopper may be about to pay, but an empty cart is not worth a card. */
const PATH_CART = new Set(["cart", "basket", "bag", "shopping-cart", "shoppingcart"]);
/** Card-field names/ids: cc-*, cardnumber, card-number/card_no, cvv, cvc, csc, exp/expiry(-date|-month|-year). */
const CARD_NAME = /^(cc[-_ ]?(name|number|num|exp[a-z-]*|csc|cvc|cvv|type)|card[-_ ]?(number|no|num)|cvv\d?|cvc\d?|csc|exp(iry|iration)?([-_ ]?(date|month|year|mm|yy|yyyy))?)$/i;

// ---- Prices that read like a plan ----
const CUR_PRE = String.raw`(?:(?:US|CA|AU|NZ|C|A)?\$|[€£¥₹]|\b(?:USD|EUR|GBP|CAD|AUD)\s?)`;
const CUR_POST = String.raw`(?:\s?(?:USD|EUR|GBP|CAD|AUD)\b|\s?[€£$])`;
const NUM = String.raw`\d[\d.,]*`;
const PRICE = String.raw`(?:${CUR_PRE}\s?${NUM}(?:\s?(?:USD|EUR|GBP|CAD|AUD)\b)?|${NUM}${CUR_POST})`;
const UNIT = String.raw`(?:(?:user|seat|member|person|editor|licen[cs]e|account)s?\s*(?:\/|per|a|an)?\s*)?`;
const PERIOD = String.raw`(?:mo\b|mos\b|month|mth|yr\b|year|annum|week|wk\b|monat|jahr|mois)`;
/** "$14.99/month", "€9 per year", "$10 per seat/month", "$12 USD / month", "US$9.99 a month", "9,99 €/Monat", "$8/user/mo". */
const PLAN_PRICE = new RegExp(String.raw`${PRICE}\*?\s*(?:\/|per|a|an|every|each|pro|par)\s*${UNIT}${PERIOD}`, "i");
/** "7-day free trial", "30 day trial", "1 month free", "free for 30 days", "$0 for 3 months". */
const TRIAL_LEN = new RegExp(
  String.raw`\d+[- ](day|week|month)s? (free )?trial|\b(\d+|one|two|three|a) (day|week|month)s? (free|for [$€£]?0\b)|\bfree for (\d+|one|two|three|a) (day|week|month)s?|${CUR_PRE}\s?0(?:[.,]00)?\s+for\s+(\d+|one|two|three|a)\s+(day|week|month)`,
  "i",
);
/** "Billed annually", "renews monthly", "Monthly price": a recurring word next to an amount in a short block. */
const RECURRING = /\bbilled\b|\brenews?\b|\b(monthly|yearly|annually|annual|weekly|per month|per year|a month|a year)\b/i;

// ---- Calls to action ----
const PAY_IFRAME = /stripe|braintree|paypal|adyen|checkout\.com|recurly|chargebee|paddle/i;
const PAY_BUTTON = /place (your )?order|pay now|complete (purchase|order)|buy now|continue to payment|proceed to payment|confirm (and|&) pay|submit (order|payment)|start (my |your )?(paid )?(membership|subscription)/i;
/** Cart-to-checkout buttons. Only a payment signal when the page also shows an amount: empty carts stay silent. */
const CHECKOUT_BUTTON = /^(continue|proceed|go) to (secure )?checkout$|^(secure )?check ?out( now| securely)?$/i;
/**
 * Plan and sign-up calls to action: "Start free trial", "Try 1 month for $0", "Try for $0.00",
 * "Get started", "Get Premium", "Choose plan", "Select plan", "Subscribe", "Join now", "Sign up".
 */
const PLAN_CTA =
  /\bstart (your |my |a )?(\d+[- ](day|week|month) )?(free )?(trial|membership|subscription)|\btry\b.{0,25}?(\bfree\b|[$€£]\s?0([.,]00)?\b)|^try (it |\w+ )?(now|today)$|^(free trial|start trial|try free|try it)$|^get started\b|^start (for free|free|now|today)$|^get (\w+[ +]?)?(premium|plus|pro|unlimited|membership)\b|^(choose|select|pick|get|buy|start) (this |the |a |your |my )?(\w+ )?plan\b|^(subscribe|join)( now| today| for)?\b|^become a member\b|\bsign up\b|\bcreate (an |your )?account\b|^upgrade( now| to \w+)?$|^(continue|proceed) to (checkout|payment|billing)\b|^claim (offer|deal|your)\b/i;
/** "Next" / "Continue" are only a call to action on a sign-up path (step 1 of a plan form). */
const STEP_CTA = /^(next|continue)$/i;
const TOTAL = /\b(sub)?total\b/i;

const BUTTONS = 'button, input[type="submit"], input[type="button"], [role="button"]';
/** Short link text is a button in all but name ("Sign up", "Start free trial" are usually <a>). */
const LINK_CTA_MAX = 40;
/** A pricing card: the CTA and the price share an ancestor with at most this much text. */
const CARD_TEXT_MAX = 400;
const PRICE_BLOCK_MAX = 120;

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
  const has = (set: Set<string>) => segments.some((seg) => set.has(seg));
  if (has(PATH_STRONG)) add(3, "path:checkout", true);
  // A sign-up path stands in for a money signal (the old rule); plan/pricing paths only add points.
  const pathSignup = has(PATH_MEDIUM);
  if (pathSignup) add(2, "path:signup");
  else if (has(PATH_PLAN)) add(2, "path:plans");
  const pathCart = has(PATH_CART);
  if (pathCart) add(2, "path:cart");

  if (hasCardField(doc)) add(4, "card-field", true);

  const iframes = Array.from(doc.querySelectorAll("iframe[src]"));
  if (iframes.some((f) => PAY_IFRAME.test(f.getAttribute("src") ?? ""))) add(3, "payment-iframe", true);

  const ctas = ctaElements(doc);
  const texts = ctas.map((c) => c.text);
  const total = hasTotalNearAmount(doc);
  if (texts.some((t) => PAY_BUTTON.test(t))) add(3, "pay-button", true);
  else if (total && texts.some((t) => CHECKOUT_BUTTON.test(t))) add(3, "checkout-button", true);

  if (total) add(1, "total-amount");

  const article = articleLike(doc);
  // A bare "Subscribe" or "Sign up" (newsletters, comment accounts) is not a purchase. The CTA
  // only counts next to a money signal: a payment signal, a total, a sign-up path, or a plan price.
  const planPriceAnywhere = PLAN_PRICE.test(pageText(doc));
  const isCta = (t: string) => PLAN_CTA.test(t) || (pathSignup && STEP_CTA.test(t));
  const ctaEls = ctas.filter((c) => isCta(c.text));
  const prices = article ? [] : priceBlocks(doc);
  // V-07 + v3: a plan price in its own short block (a pricing card, not a sentence in prose), next to a
  // call to action, or a pricing table (two or more plan prices) with a call to action anywhere.
  const planPrice =
    !article && ctaEls.length > 0 && (prices.length >= 2 || prices.some((p) => nearCta(p, ctaEls.map((c) => c.el))));
  if (ctaEls.length && (payment || total || pathSignup || planPriceAnywhere || prices.length > 0)) add(3, "signup-button");
  if (planPrice) add(2, "plan-price");

  const pageType: PageType = score >= QUALIFY_SCORE ? (payment ? "checkout" : "signup") : "none";
  return { pageType, score, signals };
}

interface Cta {
  el: Element;
  text: string;
}

/** Buttons, role=button elements, submit inputs (caption attribute only) and links with short text. */
function ctaElements(doc: Document): Cta[] {
  const out: Cta[] = [];
  for (const el of Array.from(doc.querySelectorAll(BUTTONS)).slice(0, 400)) {
    const text = buttonText(el);
    if (text.length > 0 && text.length <= 60) out.push({ el, text });
  }
  for (const a of Array.from(doc.querySelectorAll("a[href]")).slice(0, 800)) {
    if (a.getAttribute("role") === "button") continue; // already counted
    // Menu and footer links ("Sign up", "Join") sit on every page of a site: not a plan CTA. A
    // <header> only counts as site chrome when it is a short bar; some sites wrap the whole offer in one.
    if (a.closest('nav, footer, [role="navigation"], [role="contentinfo"]')) continue;
    const bar = a.closest('header, [role="banner"]');
    if (bar && cleanText(bar.textContent).length <= 600) continue;
    const text = cleanText(a.textContent || a.getAttribute("aria-label") || "").replace(/\s*[→›»>]+$/, "");
    if (text.length > 0 && text.length <= LINK_CTA_MAX) out.push({ el: a, text });
  }
  return out;
}

/**
 * Short blocks that hold a plan price. Walks text nodes that hold a currency marker (or a trial
 * length) and widens to the nearest ancestor that still reads as one short block, so a price split
 * over spans ("$" "11" ".99" "/mo") is read whole. Prose prices sit in long paragraphs and are skipped.
 */
function priceBlocks(doc: Document): Element[] {
  const body = doc.body;
  if (!body) return [];
  const found = new Set<Element>();
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  let seen = 0;
  for (let n = walker.nextNode(); n && seen < 20_000 && found.size < 40; n = walker.nextNode()) {
    seen++;
    const v = n.nodeValue ?? "";
    if (!/[$€£¥₹]|\b(USD|EUR|GBP|CAD|AUD)\b|trial|free for/i.test(v)) continue;
    const parent = n.parentElement;
    if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(parent.tagName)) continue;
    if (cleanText(parent.textContent).length > PRICE_BLOCK_MAX) continue;
    let el: Element = parent;
    for (let i = 0; i < 3 && el.parentElement && el.parentElement !== body; i++) {
      const up: Element = el.parentElement;
      if (cleanText(up.textContent).length > PRICE_BLOCK_MAX) break;
      el = up;
    }
    const t = spacedText(el);
    if (PLAN_PRICE.test(t) || TRIAL_LEN.test(t) || (hasAmount(t) && RECURRING.test(t))) found.add(el);
  }
  return Array.from(found);
}

/** Text of a short block with a space between elements, so "<b>$9.99/mo</b><i>Start</i>" does not read "moStart". */
function spacedText(el: Element): string {
  const parts: string[] = [];
  const w = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.nodeValue ?? "");
  return cleanText(parts.join(" "));
}

/** True when a call to action sits in the same pricing card as the price block. */
function nearCta(price: Element, ctas: Element[]): boolean {
  let el: Element | null = price;
  for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
    if (cleanText(el.textContent).length > CARD_TEXT_MAX) return false;
    if (ctas.some((c) => el!.contains(c))) return true;
  }
  return false;
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
    if (nonZeroAmount(own)) return true;
    const row = el.parentElement;
    if (row) {
      const rowText = cleanText(row.textContent);
      if (rowText.length <= 200 && nonZeroAmount(rowText)) return true;
    }
  }
  return false;
}

/** An empty mini-cart says "Subtotal $0.00" on every page of a shop: that is not an order. */
function nonZeroAmount(text: string): boolean {
  return parseAllAmounts(text).some((a) => a.amount > 0);
}

export interface RecheckOptions {
  /** Re-check once the DOM has had no mutations for this long. Default 3000 ms. */
  quietMs?: number;
  /** Re-check early when the element count grew by this factor since the last check. Default 1.5. */
  growth?: number;
  /** At most this many re-checks. Default 3. */
  maxChecks?: number;
  /** Stop watching after this long, qualified or not. Default 30000 ms. */
  maxMs?: number;
  /** Test hook: the classifier to run (defaults to classify). */
  classifyFn?: (doc: Document, url: string) => Classification;
}

/**
 * Late qualification for hydrated pages. Pricing pages built in the browser (React/Vue apps) have
 * no prices or buttons at document_idle, so the first classify() says "none". Call this after a
 * "none" result: it watches the DOM (read-only) and re-classifies once the DOM has been quiet for
 * `quietMs`, or sooner when the page grew a lot, at most `maxChecks` times within `maxMs`. It calls
 * `onQualify` once, with the new classification, the first time the page qualifies, then stops.
 * Returns a stop function (call it on navigation, or when another run starts).
 */
export function watchForLateQualify(
  win: Window,
  onQualify: (cls: Classification) => void,
  opts: RecheckOptions = {},
): () => void {
  const quietMs = opts.quietMs ?? 3000;
  const growth = opts.growth ?? 1.5;
  const maxChecks = opts.maxChecks ?? 3;
  const maxMs = opts.maxMs ?? 30_000;
  const run = opts.classifyFn ?? classify;
  const doc = win.document;
  const root = doc.body ?? doc.documentElement;
  if (!root) return () => undefined;
  const count = () => doc.getElementsByTagName("*").length;

  let checks = 0;
  let stopped = false;
  let lastCount = count();
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let pendingSince = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (quiet) clearTimeout(quiet);
    clearTimeout(cap);
    mo.disconnect();
  };
  const check = () => {
    quiet = undefined;
    pendingSince = 0;
    soon = false;
    if (stopped) return;
    checks++;
    lastCount = count();
    let cls: Classification | undefined;
    try {
      cls = run(doc, win.location.href);
    } catch {
      cls = undefined;
    }
    if (cls && cls.pageType !== "none") {
      stop();
      onQualify(cls);
      return;
    }
    if (checks >= maxChecks) stop();
  };
  let soon = false;
  const mo = new MutationObserver(() => {
    if (stopped || soon) return; // an early check is already booked: later mutations don't push it back
    const now = Date.now();
    if (!pendingSince) pendingSince = now;
    if (quiet) clearTimeout(quiet);
    // Significant growth (a pricing table just rendered): check soon. A page that never goes quiet
    // (a ticking clock, a carousel) is still checked once mutations have been pending for 3x quietMs.
    const n = count();
    soon = (n >= lastCount * growth && n - lastCount >= 50) || now - pendingSince >= quietMs * 3;
    quiet = setTimeout(check, soon ? Math.min(500, quietMs) : quietMs);
  });
  mo.observe(root, { childList: true, subtree: true, characterData: true });
  const cap = setTimeout(stop, maxMs);
  return stop;
}
