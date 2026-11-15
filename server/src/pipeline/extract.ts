import { LIMITS } from "@xcavate/shared";
import type { CancellationInfo, TrialInfo } from "@xcavate/shared";
import type { Paragraph } from "./split.js";
import { isNegated } from "./rules.js";
import { NUM, clip, findMoney, findPeriod, lpNormalize, splitSentences, toNumber } from "./textutil.js";

/** True when the first occurrence of `word` in `t` is negated in its clause. */
function isNegatedSafe(t: string, word: string): boolean {
  const i = t.indexOf(word);
  return i >= 0 && isNegated(t, i, i + word.length);
}

/**
 * Rules fallback for trial and cancellation details (A-10). Used when the LLM is
 * off, fails, or leaves fields empty.
 */

interface Sentence {
  s: string;
  t: string;
}

function sentencesOf(paragraphs: Paragraph[]): Sentence[] {
  return paragraphs.flatMap((p) => splitSentences(p.text).map((s) => ({ s, t: lpNormalize(s) })));
}

const TRIAL_RE = new RegExp(NUM + "[- ](day|week|month)s?[- ](free )?(trial|introductory)");
const TRIAL_RE2 = new RegExp("(free )?trial (period )?(of|lasts|lasting|for) (up to )?" + NUM + " (day|week|month)s?");

export function extractTrial(paragraphs: Paragraph[]): TrialInfo | undefined {
  const sents = sentencesOf(paragraphs);
  let lengthDays: number | undefined;
  let trialSentence: Sentence | undefined;
  for (const x of sents) {
    let n: number | undefined;
    let unit: string | undefined;
    const a = TRIAL_RE.exec(x.t);
    if (a) {
      n = toNumber(a[1]);
      unit = a[2];
    } else {
      const b = TRIAL_RE2.exec(x.t);
      if (b) {
        n = toNumber(b[5]);
        unit = b[6];
      }
    }
    if (n === undefined || isNegatedSafe(x.t, "trial")) continue;
    const days = unit === "week" ? n * 7 : unit === "month" ? n * 30 : n;
    // First trial sentence wins, unless a later one with the same length also states the price.
    if (!trialSentence) [lengthDays, trialSentence] = [days, x];
    else if (days === lengthDays && !findMoney(trialSentence.s).length && findMoney(x.s).length) trialSentence = x;
  }
  if (!lengthDays || !trialSentence) return undefined;

  // Price after the trial: the trial sentence first, then a nearby "charged ... $X" sentence.
  let priceAfter = findMoney(trialSentence.s)[0];
  let billingPeriod = findPeriod(trialSentence.s);
  let quote = trialSentence.s;
  if (!priceAfter) {
    const idx = sents.indexOf(trialSentence);
    const near = sents.slice(Math.max(0, idx - 3), idx + 6);
    const pricey =
      near.find((x) => findMoney(x.s).length && /\b(charge|charged|bill|billed|pay|price|cost|fee|per|month|year)\b/.test(x.t)) ??
      sents.find((x) => findMoney(x.s).length && /\b(after (the|your) (free )?trial|trial ends|end of (the|your) (free )?trial)\b/.test(x.t));
    if (pricey) {
      priceAfter = findMoney(pricey.s)[0];
      billingPeriod = billingPeriod ?? findPeriod(pricey.s);
    }
  }
  if (!billingPeriod) {
    const per = sents.find((x) => /\b(subscription|membership|plan)\b/.test(x.t) && findPeriod(x.s));
    if (per) billingPeriod = findPeriod(per.s);
  }
  quote = clip(quote, LIMITS.maxQuoteChars);
  const info: TrialInfo = { lengthDays };
  if (priceAfter) info.priceAfter = priceAfter;
  if (billingPeriod) info.billingPeriod = billingPeriod;
  info.quote = quote;
  return info;
}

const PHONE_NUM = /(?:\+?1[-. ])?(?:\(\d{3}\)\s?|\d{3}[-. ])\d{3}[-. ]\d{4}\b|1-8\d\d-[A-Z0-9]{3}-[A-Z0-9]{4}/;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const CANCEL = /\bcancel(l?ation|l?ations|l?ed|l?ing|s)?\b/;

function noticeDaysOf(t: string): number | undefined {
  const a = new RegExp(NUM + "[- ](calendar |business )?days?'?s?'? (prior |advance |written )?notice").exec(t);
  if (a) return toNumber(a[1]);
  const b = new RegExp("notice (period )?of (at least |not less than )?" + NUM + " (calendar |business )?days").exec(t);
  if (b) return toNumber(b[3]);
  const c = new RegExp("(at least|no later than|no less than|minimum of) " + NUM + " (calendar |business )?days (before|prior|in advance)").exec(t);
  if (c) return toNumber(c[2]);
  return undefined;
}

export function extractCancellation(paragraphs: Paragraph[]): CancellationInfo | undefined {
  const sents = sentencesOf(paragraphs);
  const cancelSents = sents.filter((x) => CANCEL.test(x.t));
  if (cancelSents.length === 0) return undefined;

  const phone = cancelSents.find(
    (x) => /\b(by (tele)?phone|by calling|call (us|our|customer|the)|telephone)\b/.test(x.t) && !isNegatedSafe(x.t, "phone"),
  );
  const mail = cancelSents.find(
    (x) => /\b(by (postal |certified |registered )?mail|by post|in writing|written (notice|request|letter))\b/.test(x.t) && !/e-?mail/.test(x.t),
  );
  const email = cancelSents.find((x) => EMAIL.test(x.s) || /\b(by e-?mail|e-?mail us|send (us )?an e-?mail)\b/.test(x.t));
  const online = cancelSents.find(
    (x) => /\b(online|in your account|account settings|in the app|cancel (anytime|at any time) (from|in|on)|cancel button|self-serve)\b/.test(x.t) && !isNegatedSafe(x.t, "online"),
  );

  let method: CancellationInfo["method"] = "unknown";
  let src: Sentence | undefined;
  if (phone) [method, src] = ["phone", phone];
  else if (mail) [method, src] = ["mail", mail];
  else if (email) [method, src] = ["email", email];
  else if (online) [method, src] = ["online", online];

  let noticeDays: number | undefined;
  let noticeSrc: Sentence | undefined;
  for (const x of cancelSents) {
    const n = noticeDaysOf(x.t);
    if (n !== undefined) {
      noticeDays = n;
      noticeSrc = x;
      break;
    }
  }
  if (method === "unknown" && noticeDays === undefined) return undefined;
  src = src ?? noticeSrc;

  // Contact as written: a phone number for phone, an email for email; look near the method sentence.
  let contact: string | undefined;
  const pool = src ? [src, ...sents] : sents;
  if (method === "phone") contact = pool.map((x) => x.s.match(PHONE_NUM)?.[0]).find(Boolean);
  else if (method === "email") contact = pool.map((x) => x.s.match(EMAIL)?.[0]).find(Boolean);

  const steps: string[] = [];
  if (method === "phone") steps.push(contact ? "Call " + contact : "Call customer support");
  else if (method === "mail") steps.push("Send a written cancellation request by mail");
  else if (method === "email") steps.push(contact ? "Email " + contact : "Email customer support");
  else if (method === "online") steps.push("Open your account settings and choose Cancel");
  if (method !== "unknown") steps.push("Ask to cancel your membership and note the confirmation");
  if (noticeDays) steps.push("Give at least " + noticeDays + " days' notice before your next billing date");
  if (steps.length === 0) steps.push("Contact the company to cancel");

  const info: CancellationInfo = { method, steps: steps.slice(0, 4) };
  if (noticeDays !== undefined) info.noticeDays = noticeDays;
  if (contact) info.contact = contact;
  if (src) info.quote = clip(src.s, LIMITS.maxQuoteChars);
  return info;
}
