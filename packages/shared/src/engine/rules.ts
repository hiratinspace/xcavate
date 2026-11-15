import { CATEGORY_ORDER, LIMITS, SEVERITY_RANK } from "../core.js";
import type { Category, Severity } from "../core.js";
import type { Paragraph } from "./split.js";
import {
  NUM,
  clip,
  clipWords,
  findMoney,
  findPercent,
  findPeriod,
  lpNormalize,
  splitSentences,
  toNumber,
  windowAround,
} from "./textutil.js";

/**
 * Rules engine (A-03): regex patterns per category over sentences. Cheap,
 * deterministic, works offline, and cannot be talked out of a finding by text in
 * the policy. Each hit is a candidate flag quoting the matched sentence.
 */

export type RuleCategory = Exclude<Category, "missing_policy">;

export interface RuleHit {
  category: RuleCategory;
  severity: Severity;
  title: string;
  summary: string;
  costImpact?: string;
  /** Exact text from the paragraph (whitespace collapsed), at most 300 chars. */
  quote: string;
  paragraphIndex: number;
  /** Short tag of the pattern that fired (for tests and debugging). */
  rule: string;
  /**
   * High-confidence clause that the model can never remove outright (whole-purchase no refund,
   * early termination fee): a model review may demote it at most one level (direction v3).
   */
  firm?: boolean;
}

interface Ctx {
  /** Original sentence. */
  s: string;
  /** Lower-cased, length-preserving normalised sentence. */
  t: string;
  /** The regex match in `t`. */
  m: RegExpExecArray;
  /** Lower-cased, length-preserving normalised paragraph the sentence came from. */
  para: string;
}

interface Pattern {
  category: RuleCategory;
  rule: string;
  re: RegExp;
  /** Default true: a negator just before the match (same clause) cancels it. */
  negatable?: boolean;
  /** Extra condition on the whole sentence. */
  when?: (c: Ctx) => boolean;
  severity: (c: Ctx) => Severity;
  text: (c: Ctx) => { title: string; summary: string; costImpact?: string };
  /** See RuleHit.firm. */
  firm?: (c: Ctx) => boolean;
}

// ---------- negation ----------

const NEGATOR = /\b(not|no|never|without|neither|nor|none|nothing|zero|free of|waive[sd]?)\b|n't\b/;
/** For arbitration, waiving a right IS the clause ("you waive class action procedures"), so "waive" is not a negator. */
const NEGATOR_ARBITRATION = /\b(not|no|never|without|neither|nor|none|nothing|zero|free of)\b|n't\b/;
const CONDITIONAL = /\b(if|unless|when|until|should)\b/;
const SUFFIX_NEGATION =
  /^[^,;:.]{0,25}?\b(does not|do not|doesn't|don't|will not|won't|shall not|is not|isn't|are not|aren't|never)\b\s+(apply|applies|be charged|be applied|be deducted|charged|required)|^\s*(is|are|will be|has been|have been)\s+waived\b|^\s*:?\s*(none|n\/a)\b|^\s*(is|are)\s+(turned off|switched off|disabled|off)\b|^[^,;:.]{0,25}?\bwill not be withheld\b/;

const HARD_BOUNDARY = /[;:()]|\b(but|however|although|whereas|except)\b/g;
const SOFT_BOUNDARY = /,|\b(and|or)\b/g;

function boundaryEnds(s: string, re: RegExp): number[] {
  const out: number[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m.index + m[0].length);
  return out;
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * The clause that ends just before a match. Hard boundaries (";", "but") always cut.
 * Soft ones ("," "and" "or") cut only when what follows them has 4+ words, so a list
 * like "we do not add service, processing or convenience fees" stays one clause.
 */
export function clauseBefore(before: string): string {
  const hard = boundaryEnds(before, HARD_BOUNDARY);
  const seg = hard.length ? before.slice(hard[hard.length - 1]) : before;
  const cuts = boundaryEnds(seg, SOFT_BOUNDARY);
  for (let i = cuts.length - 1; i >= 0; i--) {
    const tail = seg.slice(cuts[i]);
    if (wordCount(tail) >= 4) return tail;
  }
  return seg;
}

/** True when the match is cancelled by a negation in its own clause ("we do not charge a restocking fee"). */
export function isNegated(t: string, start: number, end: number, category?: Category): boolean {
  const before = t.slice(0, start);
  const clause = clauseBefore(before);
  const words = clause.trim().split(/\s+/).slice(-8).join(" ");
  const neg = (category === "arbitration" ? NEGATOR_ARBITRATION : NEGATOR).exec(words);
  if (neg) {
    // "If you do not cancel ..." is a condition, not a denial: look for if/unless anywhere
    // earlier in the clause, not just in the 8-word window.
    const trimmed = clause.trim();
    const negAt = trimmed.length - words.length + neg.index;
    const cond = CONDITIONAL.exec(trimmed);
    if (!(cond && cond.index < negAt)) return true;
  }
  return SUFFIX_NEGATION.test(t.slice(end, end + 60));
}

// ---------- helpers for templates ----------

function money(c: Ctx): string | undefined {
  return findMoney(c.s)[0];
}


function priceWithPeriod(c: Ctx): string | undefined {
  const m = money(c);
  if (!m) return undefined;
  const p = findPeriod(c.s);
  return p ? m + " per " + p : m;
}

const TRIAL_VERB =
  /\b(automatic(ally)?|will be (charged|billed)|we will charge|you will pay|converts?|convert(ed)? (in)?to|becomes? a paid|be charged|be billed|start(s)? (charging|billing))\b/g;

export const YEARLY = /\b(annual(ly)?|yearly|each year|every year|per year|12-month|twelve-month|one-year|1-year)\b/;
const MONTHLY = /\b(monthly|month-to-month|each month|every month|per month|a month)\b/;
const WEEKLY = /\b(weekly|each week|every week|per week|a week)\b/;
const NO_REMINDER = /without (prior |advance |any )?(notice|reminder|notifying|notification)|no (reminder|notice) (will be|is) (sent|given)/;
export const AUTO_CHARGE = /\b(automatic(ally)?|will be (charged|billed)|we will charge|unless you cancel|charged (to|on) (your|the) (card|payment method))\b/;

/**
 * Drop conditional and exception clauses ("unless ..., or ...,", "except ...", parentheses) so a plan
 * or period named only inside them does not count: "Unless cancelled ..., or such Trial is in
 * conjunction with a Prepaid Period, you will be charged" is not a prepaid trial.
 */
export function stripConditionals(t: string): string {
  return t
    .replace(/\([^()]*\)/g, " ")
    .replace(/\b(unless|except|other than|excluding|if)\b[^,;.]*(,\s*(or|and)\b[^,;.]*)*/g, " ");
}

/** Advance notice promised ("we will notify you at least one month before", "ten days' advance notice"), not denied. */
const NOTICE_PROMISE =
  /\b(we will|we'll|we shall|we will attempt to|will) (provide|give|send|notify|email|tell|inform|let you know)\b[^.]{0,80}?\b(notice|notif\w*|in advance|before|prior)|\b(advance|prior) (written |e-?mail )?notice\b|\bnotify you\b[^.]{0,40}?\b(at least|in advance|before|prior)|\battempt to notify you\b/g;

export function promisesNotice(text: string): boolean {
  // Sentence by sentence, so a denial in one sentence does not cancel a promise in the next.
  for (const t of text.split(/(?<=[.!?])\s+/)) {
    NOTICE_PROMISE.lastIndex = 0;
    for (let m = NOTICE_PROMISE.exec(t); m; m = NOTICE_PROMISE.exec(t)) {
      // "without prior notice" is the opposite of a promise.
      if (/\b(without|no)\s+$/.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;
      if (!isNegated(t, m.index, m.index + m[0].length)) return true;
    }
  }
  return false;
}

/** The period a renewal sentence states, if exactly one ("monthly or annually" states none). */
function renewalPeriod(c: Ctx): string {
  return renewalPeriodOf(c.s);
}

/** A clause that states a term (modal, condition or present-tense rule), not a story ("Then you got the auto-renewal invoice."). */
const TERM_LIKE = /\b(will|shall|must|may|can|unless|until|each|every|automatic(ally)?|agree|subject to|is|are|includes?|continues?|renews?)\b/;
const NARRATIVE = /^\s*(then|so|say|for example|e\.g\.)\b|\byou (got|received|forgot|decided|meant|were charged|signed up and)\b/;

function noticeDays(t: string): number | undefined {
  const a = new RegExp(NUM + "[- ](calendar |business )?days?'?s?'? (prior |advance |written )?notice").exec(t);
  if (a) return toNumber(a[1]);
  const b = new RegExp("notice (period )?of (at least |not less than )?" + NUM + " (calendar |business )?days").exec(t);
  if (b) return toNumber(b[3]);
  const c = new RegExp("(at least|no later than|no less than|minimum of) " + NUM + " (calendar |business )?days (before|prior|in advance)").exec(t);
  if (c) return toNumber(c[2]);
  return undefined;
}

/**
 * Phone or postal mail as a channel. "In writing" and "written notice" are not mail: written notice
 * is often an email or a web form, so they never make a "Cancel by mail" headline.
 */
const PHONE_OR_MAIL =
  /\b(by (tele)?phone|by calling|calling (us|our|customer|the)|call (us|our|customer|the)|telephone|phone (call|line|number)|by (postal |certified |registered |first[- ]class )?(mail|post)\b|(certified|registered) (letter|mail)|send (us )?a letter)/;
const CANCEL = /\bcancel(l?ation|l?ations|l?ed|l?ing|s)?\b|\bterminat(e|es|ed|ing|ion)\b/;
const CANCEL_G = new RegExp(CANCEL.source, "g");

/**
 * The channel is how YOU cancel: a cancel verb and the channel sit in the same clause, close together,
 * and the channel is not about something else being sent or delivered ("delivery will switch to mail").
 */
export function cancelVia(t: string, channel: RegExp = PHONE_OR_MAIL): RegExpExecArray | null {
  const re = new RegExp(channel.source, "g");
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const lead = t.slice(Math.max(0, m.index - 30), m.index);
    if (/\b(deliver(y|ed|ies)?|sent|shipped|mailed|received?|send you|issued)( to you)?\s*$/.test(lead)) continue;
    CANCEL_G.lastIndex = 0;
    for (let k = CANCEL_G.exec(t); k; k = CANCEL_G.exec(t)) {
      const [a, b] = k.index < m.index ? [k.index + k[0].length, m.index] : [m.index + m[0].length, k.index];
      if (b - a > 70) continue;
      const between = t.slice(a, b);
      if (/[;:.()]|\b(but|however|although|whereas|except|while)\b/.test(between)) continue;
      if (/\b(switch(es|ed)?|convert(s|ed)?|chang(e|es|ed) to|move[sd]? to|transfer(s|red)?)\b/.test(between)) continue;
      return m;
    }
  }
  return null;
}

/** Self-serve ways to cancel. Bare "your account" is not one ("cancel your account, call us"). */
const SELF_SERVE =
  /\b(online|website|web site|web form|webpage|in (the|our) app|mobile app|in-app|(in|from|through|via|on|to) (your|the|my) account( page| settings| tab)?|account (settings|page|dashboard|tab|section)|(in|on|under) (the )?settings|settings page|click(ing)?|self-serve|cancel button|one click)\b/g;
/** Contacting support in writing or live without a phone call. Still "contact support", not self-serve. */
const SUPPORT_CHANNEL = /\b(e-?mail(ing)?|chat(ting)?)\b/g;

function hasChannel(t0: string, re: RegExp): boolean {
  // Quoted page names ('go to the "Account" page') must read like plain words.
  const t = t0.replace(/"/g, "");
  re.lastIndex = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    if (/\b(cannot|can't|can not|unable to|not able to|isn't possible|no) (be )?(cancel(l?ed)?|cancell?ation)? ?$/.test(before)) continue;
    if (!isNegated(t, m.index, m.index + m[0].length)) return true;
  }
  return false;
}

/** True when `t` offers a self-serve way to cancel that is not itself denied ("cannot cancel online"). */
export function hasSelfServe(t: string): boolean {
  return hasChannel(t, SELF_SERVE);
}

/** True when `t` offers any non-phone, non-mail way to cancel: self-serve, email or chat. */
export function hasAltChannel(t: string): boolean {
  return hasSelfServe(t) || hasChannel(t, SUPPORT_CHANNEL);
}

/** The company, not the shopper, ends the contract ("we may terminate your account with 30 days' notice"). */
function companyTerminates(t: string): boolean {
  return (
    /\b(we|us|the company)\b[^.]{0,20}\b(may|will|can|reserve the right to|have the right to)\b[^.]{0,20}\b(terminat|cancel|suspend)/.test(t) &&
    !/\byou (must|need to|have to|shall|are required to|may|can)\b[^.]{0,40}\b(cancel|terminat)/.test(t)
  );
}

/** Wording that makes phone or mail the only route. */
const EXPLICIT_ONLY =
  /\b(only|must|solely|exclusively|required to|need to|have to)\b|\b(cannot|can't|can not|unable to)( be)? cancel(l?ed)? online\b|\bnot (available|possible) online\b/;
const SUBSCRIPTION_CONTEXT = /\b(subscription|membership|plan|account|service|contract|agreement)\b/;

/** Fees and refunds inside a dispute-resolution clause are about arbitration costs, not the purchase. */
const ARBITRATION_CONTEXT = /\b(arbitrat\w*|filing fees?|adr services|jams|aaa|nam\b|mediator|tribunal)/;

/** Cancellation friction severity in code (rules and model alike): high only for phone/mail-only or 30+ days' notice. */
export function cancelFrictionSeverity(text: string): Severity {
  const t = lpNormalize(text);
  if (/\b(cannot|can't|can not|unable to)( be)? cancel(l?ed)? online\b|\bnot (available|possible) online\b/.test(t)) return "high";
  if ((noticeDays(t) ?? 0) >= 30) return "high";
  if (hasSelfServe(t)) return "low";
  if (cancelVia(t) && !hasAltChannel(t) && EXPLICIT_ONLY.test(t)) return "high";
  return "medium";
}

const REFUND_DEDUCTION =
  /\b(deduct(ed|ion|ions|s)?|subtract(ed)?|withheld|taken)\b[^.]{0,60}?\b(from|off) (your |the )?refund|\brefund\w*\b[^.]{0,60}?\b(minus|less|reduced by|deduct\w*)\b|\bmissing (parts|pieces|components|accessories|items)\b/;
const NARROW_REFUND_SCOPE =
  /\b(chang(e|es|ing)|switch(es|ing)?|upgrad(e|es|ing)|downgrad(e|es|ing)|mov(e|es|ing)) (from|to|between|into|your|plans?|subscriptions?)\b|\b(gift cards?|add-ons?|in-app (purchases|items)|virtual (items|currency)|tips|deposits?|account (balance|credit)|promotional credits?)\b|\bload(ed)? (a |an )?(non-?refundable )?amount\b/;
const PARTIAL_PERIOD =
  /\b(partial(ly)?[- ](used |unused )?(subscription |billing |membership )?(periods?|months?|terms?|years?|weeks?|billing)|prorat(ed|ion|e)|pro[- ]rata|unused (portion|time|part|days)|remain(ing|der of) (the |your |any )?(current )?(billing|subscription|membership) (period|cycle|term|month)|mid-(cycle|period|term|month))\b/;

/** A return or restocking fee that only applies to returns breaking the return policy. */
export function isNoncompliantReturnFee(text: string): boolean {
  return NONCOMPLIANT_RETURN.test(lpNormalize(text));
}

/** The renewal period a text states: " every year", " every month", " each billing period" or "". */
export function renewalPeriodOf(text: string): string {
  const t = stripConditionals(lpNormalize(text));
  const found = [YEARLY.test(t) && " every year", MONTHLY.test(t) && " every month", WEEKLY.test(t) && " every week"].filter(
    (x): x is string => Boolean(x),
  );
  if (found.length > 1) return " each billing period";
  if (found[0]) return found[0];
  const p = findPeriod(text);
  return p ? " every " + p : "";
}

/** "No refunds or credits for partially used subscription periods": the normal subscription rule. */
export function isPartialPeriodNoRefund(text: string): boolean {
  const t = lpNormalize(text);
  return PARTIAL_PERIOD.test(t) && !/\ball (sales|purchases|orders) (are )?(final|non-?refundable)\b/.test(t);
}

const NONCOMPLIANT_RETURN =
  /\b(do(es)? not|don't|doesn't|fail(s)? to) (comply|meet|follow|conform)|\bnon-?compliant\b|\bnot in (its |their |the )?original (condition|packaging|state)\b|\b(damaged|used|worn|altered) (items?|products?|merchandise|returns?)\b|\bmissing (parts|pieces|tags|accessories)\b|\boutside (of )?(the|our) return (policy|window|period)\b/;

const THIRD_PARTY_OR_HEDGED_FEE =
  /\b(possible|potential)\b[^.]{0,25}\b(fee|charge|surcharge)s?\b|\b(issuer|your (bank|card provider|carrier|internet provider|mobile carrier)|card (issuer|provider)|financial institution|third[- ]part(y|ies))\b[^.]{0,60}\b(fee|charge|surcharge)s?\b|\b(fee|charge|surcharge)s?\b[^.]{0,60}\b(charged|imposed|set) by (your|a|the) (bank|issuer|card|carrier|provider|third part)/;

/**
 * The same scope gates the rules apply, for any quote (model quotes included): true when the
 * sentence is not evidence for the category even though it carries a keyword.
 */
export function outOfScopeForCategory(category: Category, text: string): boolean {
  const t = lpNormalize(text);
  switch (category) {
    case "auto_renewal":
      return !TERM_LIKE.test(t) || NARRATIVE.test(t);
    case "no_refund":
      return REFUND_DEDUCTION.test(t) || NARROW_REFUND_SCOPE.test(t);
    case "extra_fees":
      return THIRD_PARTY_OR_HEDGED_FEE.test(t);
    case "data_sharing":
      return deniesDataSharing(t);
    default:
      return false;
  }
}

/** "We do not sell ...", or a sentence about not collecting data on children. */
function deniesDataSharing(t: string): boolean {
  if (/\b(do not|don't|does not|doesn't|never|will not|won't|shall not)\b[^.]{0,30}\b(sell|share|rent|disclose|collect)/.test(t)) return true;
  return /\b(children|child|minors?|under (the age of )?1[3-8])\b/.test(t) && /\b(not|never|no)\b/.test(t);
}

function priceChangeSilent(c: Ctx): boolean {
  const silent = NO_REMINDER.test(c.t) || (/\bat any time\b/.test(c.t) && !/notif|notice|email you|tell you/.test(c.t));
  return silent && !promisesNotice(c.t) && !promisesNotice(c.para);
}

// ---------- patterns ----------

const PATTERNS: Pattern[] = [
  // auto_renewal
  {
    category: "auto_renewal",
    rule: "renews",
    re: /\b(auto-?renew(s|al|als|ed|ing)?|automatic(ally)? renew(s|al|als|ed|ing)?|renews? automatically|will (automatically )?renew|(automatically )?(renew|continue)s? (each|every) (month|year|week|billing)|continues? until (you cancel|cancell?ed|canceled)|until you cancel|until (it is |they are )?(cancell?ed|canceled)|recurring (charges?|payments?|billing|subscription|fees?)|(charge|bill) (you|your [a-z ]{0,24}?) (automatically )?(each|every|at the start of each) (month|year|week|billing))/,
    when: (c) => TERM_LIKE.test(c.t) && !NARRATIVE.test(c.t),
    severity: (c) => (isYearlyOrPrepaid(c.s) || NO_REMINDER.test(c.t) ? "high" : "medium"),
    text: (c) => {
      const per = renewalPeriod(c);
      return {
        title: "Renews automatically" + per,
        summary: "Your plan keeps charging you" + per + " until you cancel it.",
        costImpact: priceWithPeriod(c),
      };
    },
  },
  // trial_converts
  {
    category: "trial_converts",
    rule: "trial-then-charge",
    re: /\b(free trial|trial period|trial|introductory (period|offer|price)|promotional period)\b[^.;:]{0,160}?\b(automatic(ally)?|will be (charged|billed)|we will charge|you will pay|converts?|convert(ed)? (in)?to|becomes? a paid|be charged|be billed|start(s)? (charging|billing))\b/,
    negatable: false,
    // The charge/convert verb must not be denied ("you will not be charged automatically", "will not convert").
    when: (c) => {
      const from = c.m.index;
      TRIAL_VERB.lastIndex = from;
      for (let v = TRIAL_VERB.exec(c.t); v; v = TRIAL_VERB.exec(c.t)) {
        if (!isNegated(c.t, v.index, v.index + v[0].length)) return true;
      }
      return false;
    },
    severity: (c) => (AUTO_CHARGE.test(c.t) || /\bconvert/.test(c.t) ? "high" : "medium"),
    text: (c) => {
      const days = new RegExp(NUM + "[- ]day").exec(c.t);
      const d = days ? toNumber(days[1]) : undefined;
      const price = priceWithPeriod(c);
      return {
        title: "Free trial turns into a paid plan",
        summary:
          (d ? "After " + d + " days you" : "When the trial ends you") +
          " are charged" +
          (price ? " " + price : "") +
          " automatically unless you cancel first.",
        costImpact: price ? price + " after the trial" : undefined,
      };
    },
  },
  {
    category: "trial_converts",
    rule: "charge-after-trial",
    re: /\b(charged|billed|charge (you|your (card|payment method|account))|bill (you|your (card|payment method|account))|converts?|payment method will be)\b[^.;:]{0,120}?\b(end of (the |your )?(free )?trial|trial (period )?(ends|expires|is over)|(after|following) (the |your )?(free )?trial)/,
    severity: (c) => (AUTO_CHARGE.test(c.t) || /\b(charged|billed|charge|bill|converts?)\b/.test(c.t) ? "high" : "medium"),
    text: (c) => {
      const price = priceWithPeriod(c);
      return {
        title: "Free trial turns into a paid plan",
        summary: "When the trial ends you are charged" + (price ? " " + price : "") + " automatically unless you cancel first.",
        costImpact: price ? price + " after the trial" : undefined,
      };
    },
  },
  // cancellation_friction
  {
    category: "cancellation_friction",
    rule: "phone-or-mail",
    re: PHONE_OR_MAIL,
    // The channel must be how you cancel (a cancel verb governs it in the same clause). Not a finding
    // when the sentence offers a self-serve way; when only the paragraph does, fire only for explicit
    // "must/only" wording. Email or chat next to the phone is still "contact support" (medium).
    when: (c) =>
      cancelVia(c.t) !== null &&
      !companyTerminates(c.t) &&
      !hasSelfServe(c.t) &&
      (EXPLICIT_ONLY.test(c.t) || !hasSelfServe(c.para)),
    severity: (c) => cancelFrictionSeverity(c.s),
    text: (c) => {
      const n = noticeDays(c.t);
      if (hasAltChannel(c.t))
        return {
          title: "Cancel only through customer support",
          summary: "You cannot cancel yourself in your account; you have to contact support by phone, email or chat.",
        };
      const ch = cancelVia(c.t)?.[0] ?? c.m[0];
      const mail = /mail|post\b|letter/.test(ch);
      const only = EXPLICIT_ONLY.test(c.t);
      return {
        title: (mail ? "Cancel by mail" : "Cancel by phone") + (only ? " only" : "") + (n ? ", " + n + " days' notice" : ""),
        summary:
          (mail ? "You have to cancel by mail" : "You have to call to cancel") +
          (n ? ", and you must give " + n + " days' notice." : "."),
      };
    },
  },
  {
    category: "cancellation_friction",
    rule: "notice-period",
    re: new RegExp(NUM + "[- ](calendar |business )?days?'?s?'? (prior |advance |written )?notice|notice (period )?of (at least |not less than )?" + NUM + " (calendar |business )?days|(at least|no later than|no less than|minimum of) " + NUM + " (calendar |business )?days (before|prior|in advance)"),
    when: (c) => CANCEL.test(c.t) && !companyTerminates(c.t),
    severity: (c) => ((noticeDays(c.t) ?? 0) >= 30 ? "high" : "medium"),
    text: (c) => {
      const n = noticeDays(c.t);
      return {
        title: "Cancelling needs " + (n ?? "advance") + (n ? " days'" : "") + " notice",
        summary: "You must tell them" + (n ? " " + n + " days" : "") + " before you want to cancel, so you may pay for extra time.",
      };
    },
  },
  {
    category: "cancellation_friction",
    rule: "contact-support",
    re: /\b(must|need to|have to|required to|only by|only through) (contact|email|call|reach|write to) (our |the )?(customer )?(support|service|care|team|us)\b|\bcannot be cancell?ed online\b|\bcan(not|'t) cancel online\b/,
    negatable: false,
    when: (c) => CANCEL.test(c.t) && SUBSCRIPTION_CONTEXT.test(c.t),
    severity: (c) => (/online/.test(c.m[0]) || PHONE_OR_MAIL.test(c.t) ? "high" : "medium"),
    text: () => ({
      title: "You must contact support to cancel",
      summary: "You cannot cancel yourself in your account; you have to contact the company and ask.",
    }),
  },
  // termination_fee
  {
    category: "termination_fee",
    rule: "etf",
    re: /\b(early termination (fee|charge|penalty)s?|termination (fee|charge|penalty)s?|early cancell?ation (fee|charge|penalty)s?|cancell?ation (fee|charge|penalty)s?|exit (fee|charge)s?|liquidated damages|(pay|charged?|owe|billed)( for)? (the |all )?(remaining|remainder of (the|your)) (months|term|balance|subscription|contract|commitment|minimum term))/,
    severity: () => "high",
    firm: () => true,
    text: (c) => {
      const amt = money(c) ?? findPercent(c.s);
      return {
        title: "Fee for cancelling early",
        summary: "If you cancel before the term ends, you pay an extra fee" + (amt ? " of " + amt : "") + ".",
        costImpact: amt ? amt + " early termination fee" : undefined,
      };
    },
  },
  // no_refund
  {
    category: "no_refund",
    rule: "final-sale",
    re: /\b(all (sales|purchases|payments|orders) (are )?(final|non-?refundable)|no refunds?\b(?! (is|are) (needed|required))|non-?refundable|no money[- ]back|(will|do|does|shall|cannot|can't|won't) not? ?(be )?(issue|give|provide|offer|receive|grant|eligible for|entitled to)\w* (a |any )?(refund|money back)|(do|does|will|shall|won't|don't|doesn't) (not )?refund\b|refunds? (are|is|will be) not (available|offered|provided|issued|given|possible)|not (be )?(eligible|entitled) (for|to) (a |any )?refunds?|we do not (offer|issue|give|provide) refunds?)/,
    negatable: false,
    // "Shipping charges are non-refundable" on its own is normal; do not call it a no-refund policy.
    when: (c) => {
      const before = c.t.slice(0, c.m.index);
      if (ARBITRATION_CONTEXT.test(c.t)) return false;
      // A deduction from a refund ("deducted from your refund", "missing parts") still pays a refund.
      if (REFUND_DEDUCTION.test(c.t)) return false;
      // Narrow scope (switching plans, gift cards, add-ons, account balance) is not a rule about the purchase.
      if (NARROW_REFUND_SCOPE.test(c.t)) return false;
      // Gift cards and shipping being final or non-refundable is normal; the purchase itself is what matters.
      if (/\b(shipping|delivery|postage|gift wrap|gift cards?|customs|duties)\b/.test(before)) return false;
      // "Returns that do not comply ... may not be eligible for a refund": a condition, not a policy.
      if (/\b(eligible|entitled)\b/.test(c.m[0]) && (/\bmay not\b/.test(c.t) || /\b(if|unless|that do not|which do not|that are not)\b/.test(before)))
        return false;
      return true;
    },
    // Partial-period boilerplate ("no refunds for partially used subscription periods") is how nearly
    // every subscription works: low, with a context line (score.ts). The whole purchase is high and firm.
    severity: (c) => (isPartialPeriodNoRefund(c.t) ? "low" : "high"),
    firm: (c) => !isPartialPeriodNoRefund(c.t),
    text: (c) =>
      isPartialPeriodNoRefund(c.t)
        ? {
            title: "No refunds for part of a billing period",
            summary: "If you cancel mid-period, you keep access until the period ends but get no money back for it.",
          }
        : {
            title: "No refunds",
            summary: "Once you pay, you cannot get your money back.",
          },
  },
  {
    category: "no_refund",
    rule: "store-credit",
    re: /\b(store credit only|only (in the form of |as |issue |offer )?(a )?store credit|refunds? (are |will be )?(issued |given |provided |offered )?(only )?(as|in the form of|in) (a )?(store credit|gift card|voucher|credit))/,
    severity: () => "medium",
    text: () => ({
      title: "Refunds only as store credit",
      summary: "If you return something, you get store credit instead of your money back.",
    }),
  },
  {
    category: "no_refund",
    rule: "short-window",
    re: new RegExp(
      "(refund|return)[^.]{0,80}?within " + NUM + " (calendar |business )?days (of|from|after) (the )?(date of )?(purchase|delivery|receipt|receiving|buying|your (order|purchase|delivery)|the (order|purchase|delivery))|" +
        NUM + "[- ]day (refund|return|money-back) (window|period|policy|guarantee)",
    ),
    when: (c) => {
      // Processing times ("we issue the refund within 5 days") are not limits on the shopper.
      if (/\b(we|our team) (will )?(inspect|process|issue|send|refund)\b|goes back|be (processed|credited|issued)/.test(c.t)) return false;
      const m = new RegExp("within " + NUM + " |" + NUM + "[- ]day").exec(c.t);
      const n = m ? toNumber(m[1] ?? m[2]) : undefined;
      return n !== undefined && n <= 14;
    },
    severity: () => "medium",
    text: (c) => {
      const m = new RegExp("within " + NUM + " |" + NUM + "[- ]day").exec(c.t);
      const n = m ? toNumber(m[1] ?? m[2]) : undefined;
      return {
        title: "Short refund window" + (n ? " (" + n + " days)" : ""),
        summary: "You only have" + (n ? " " + n + " days" : " a short time") + " to ask for a refund.",
      };
    },
  },
  // return_cost
  {
    category: "return_cost",
    rule: "restocking",
    re: /\brestocking (fee|charge)s?\b/,
    // A fee only for returns that break the return policy is a penalty most shoppers never meet: low.
    severity: (c) => (NONCOMPLIANT_RETURN.test(c.t) ? "low" : "medium"),
    text: (c) => {
      const amt = findPercent(c.s) ?? money(c);
      if (NONCOMPLIANT_RETURN.test(c.t))
        return {
          title: "Restocking fee on returns that break the rules" + (amt ? " (" + amt + ")" : ""),
          summary: "Returns that do not meet the return policy can cost you a restocking fee" + (amt ? " of up to " + amt : "") + ".",
          costImpact: amt ? amt + " restocking fee" : undefined,
        };
      return {
        title: "Restocking fee on returns" + (amt ? " (" + amt + ")" : ""),
        summary: "Returning an item costs you" + (amt ? " a " + amt + " restocking fee" : " a restocking fee") + " taken from your refund.",
        costImpact: amt ? amt + " restocking fee" : undefined,
      };
    },
  },
  {
    category: "return_cost",
    rule: "buyer-pays-return-shipping",
    re: /\b((you|buyer|customer|customers|purchaser)( is| are| will be)? (responsible for|pays?|must pay|will pay|bears?|covers?|cover) (all |the |any )?(costs? of )?(return shipping|return postage|shipping costs? (for|of) (the )?returns?|the cost of (the )?return( shipping)?|return delivery)|return (shipping|postage)( costs?| fees?| charges?)? (are|is|will be) (paid by (you|the (buyer|customer))|the (buyer|customer)'?s? responsibility|your responsibility|at your (own )?expense|at the (buyer|customer)'?s? expense|deducted|non-?refundable)|(return shipping|return label)( fee| cost)?[^.]{0,40}deducted from (your|the) refund)/,
    severity: () => "medium",
    text: (c) => ({
      title: "You pay return shipping",
      summary: "If you send something back, the cost of shipping it is yours.",
      costImpact: money(c) ? money(c) + " return shipping" : undefined,
    }),
  },
  {
    category: "return_cost",
    rule: "return-fee",
    re: /\breturn(s)? (shipping |processing |label )?(fee|charge)s?\b|\b(fee|charge|cost)s?\b[^.;]{0,40}?\b(deducted|taken|subtracted|withheld) from (your|the) refund/,
    when: (c) => !/\brestocking\b/.test(c.t) && !ARBITRATION_CONTEXT.test(c.t),
    severity: (c) => (NONCOMPLIANT_RETURN.test(c.t) ? "low" : "medium"),
    text: (c) => {
      const amt = money(c) ?? findPercent(c.s);
      return {
        title: "Fee for returns" + (amt ? " (" + amt + ")" : ""),
        summary: "Sending something back costs you" + (amt ? " " + amt : " a fee") + ", taken from your refund.",
        costImpact: amt ? amt + " return fee" : undefined,
      };
    },
  },
  // price_change
  {
    category: "price_change",
    rule: "may-change-price",
    re: /\b((we )?(may|can|reserve the right to|are entitled to|have the right to) (change|modify|adjust|increase|raise|update)\b[^.;:]{0,60}?\b(prices?|pricing|fees|rates|charges)\b|(prices?|pricing|fees) (are|is) subject to change|(prices?|pricing) (may|can|will) (change|increase|go up))/,
    when: (c) => !ARBITRATION_CONTEXT.test(c.t),
    // High only when it can change without notice and neither the sentence nor its paragraph promises
    // advance notice ("...without notice; provided, however, that we will provide at least ten days' notice").
    severity: (c) => (priceChangeSilent(c) ? "high" : "medium"),
    text: (c) => {
      const high = priceChangeSilent(c);
      return {
        title: high ? "Price can change without notice" : "Price can change",
        summary: high
          ? "They can raise what you pay at any time without telling you first."
          : "They can raise what you pay; check how they tell you before it happens.",
      };
    },
  },
  // extra_fees
  {
    category: "extra_fees",
    rule: "named-fee",
    re: /\b(service|processing|convenience|handling|administrative|admin|booking|platform|transaction|activation|setup|set-up) (fee|charge|surcharge)s?\b|\bsurcharges?\b/,
    // Not the seller's fee when a third party charges it (your bank, card issuer, carrier) or it is only
    // hedged as possible.
    when: (c) => !/\brestocking\b/.test(c.t) && !ARBITRATION_CONTEXT.test(c.t) && !THIRD_PARTY_OR_HEDGED_FEE.test(c.t),
    severity: () => "medium",
    text: (c) => {
      const amt = money(c);
      return {
        title: "Extra fees on top of the price",
        summary: "You pay a named fee" + (amt ? " of " + amt : "") + " on top of the price, tax and shipping.",
        costImpact: amt ? amt + " fee" : undefined,
      };
    },
  },
  // arbitration
  {
    category: "arbitration",
    rule: "arbitration",
    re: /\b(binding (individual )?arbitration|arbitration (agreement|clause|provision)|resolved? (exclusively |solely )?(by|through) (final and binding |binding )?arbitration|submit(ted)? to (binding )?arbitration|(waive|waiving|give up) (any |your |the )?(right|rights) to (a )?(jury trial|trial by jury|participate in a class|bring a class|class action)|class[- ]action waiver|(no|not) (participate|bring|join) (in )?(a |any )?class[- ]action|on an individual basis(,)? (and )?not (as a|in a) (class|representative))/,
    negatable: true,
    severity: () => "low",
    text: () => ({
      title: "Disputes go to private arbitration",
      summary: "You give up the right to sue in court or join a class action.",
    }),
  },
  // data_sharing
  {
    category: "data_sharing",
    rule: "sells-data",
    re: /\b((we )?(may |will |can )?sell (your |the |certain )?(personal (data|information)|data|information)|sale of (your )?personal (data|information)|(sold|rent(ed)?) to (third parties|data brokers|advertisers))/,
    when: (c) => !deniesDataSharing(c.t),
    severity: () => "medium",
    text: () => ({
      title: "May sell your personal data",
      summary: "Your personal information can be sold to other companies.",
    }),
  },
  {
    category: "data_sharing",
    rule: "shares-with-partners",
    re: /\bshar(e|es|ed|ing) (your |the )?(personal )?(data|information|details)[^.]{0,60}?\b(advertising partners|marketing partners|data brokers|advertisers|for (their own )?(marketing|advertising) purposes)/,
    when: (c) => !deniesDataSharing(c.t),
    severity: () => "low",
    text: () => ({
      title: "Shares your data with partners",
      summary: "Your personal information is shared with advertising or marketing partners.",
    }),
  },
];

function quoteFor(c: Ctx): string {
  const max = LIMITS.maxQuoteChars;
  if (c.s.length <= max) return c.s;
  return clip(windowAround(c.s, c.m.index, c.m.index + c.m[0].length, max), max);
}

/** All rule hits in one paragraph. */
export function matchParagraph(p: Paragraph): RuleHit[] {
  const hits: RuleHit[] = [];
  const para = lpNormalize(p.text);
  for (const s of splitSentences(p.text)) {
    // Headings ("Restocking fee") are not clauses; the sentence that follows them is.
    if (wordCount(s) < 5) continue;
    const t = lpNormalize(s);
    for (const pat of PATTERNS) {
      const m = pat.re.exec(t);
      if (!m) continue;
      const c: Ctx = { s, t, m, para };
      if (pat.negatable !== false && isNegated(t, m.index, m.index + m[0].length, pat.category)) continue;
      if (pat.when && !pat.when(c)) continue;
      const txt = pat.text(c);
      hits.push({
        category: pat.category,
        severity: pat.severity(c),
        title: clip(txt.title, LIMITS.maxTitleChars),
        summary: clipWords(txt.summary, LIMITS.maxSummaryWords),
        costImpact: txt.costImpact,
        quote: quoteFor(c),
        paragraphIndex: p.index,
        rule: pat.rule,
        ...(pat.firm?.(c) ? { firm: true } : {}),
      });
    }
  }
  return hits;
}

/** All rule hits in a list of paragraphs, in document order. */
// ---------- document-level facts used to calibrate severity (V-01) ----------

function sentencesLower(paragraphs: Paragraph[]): string[] {
  return paragraphs.flatMap((p) => splitSentences(p.text).map(lpNormalize));
}

/** The policy offers a self-serve or online way to cancel (account settings, online, app, email). */
export function offersOnlineCancel(paragraphs: Paragraph[]): boolean {
  return sentencesLower(paragraphs).some((t) => CANCEL.test(t) && hasAltChannel(t));
}

/** The policy says no reminder or notice comes before a renewal or trial charge. */
export function statesNoReminder(paragraphs: Paragraph[]): boolean {
  const RE =
    /\b(without (prior |advance |any )?(notice|reminder|notifying you|notification)|(we|will) (do not|don't|will not|won't) (send|give|provide) (you )?(a |any )?(separate |additional |advance |prior |further )?(reminder|notice|notification)|(will not|won't|do not|don't|will never) (receive|get|be sent|be given) (a |any )?(separate |additional |advance |prior |further )?(reminder|notice|notification|e-?mail)|no (separate |advance )?(reminder|notice|notification) (will be|is) (sent|given|provided))/;
  return sentencesLower(paragraphs).some((t) => RE.test(t) && /\b(renew|trial|charge|bill)/.test(t));
}

/** Prepaid or yearly terms ("annual plan", "billed annually", "paid in advance"). */
export function isYearlyOrPrepaid(text: string): boolean {
  // Plans named only in an exception ("unless ... a Prepaid Period") do not count, and a choice of
  // periods ("monthly or annually") is not a yearly plan.
  const t = stripConditionals(lpNormalize(text));
  if (/\b(prepaid|pre-paid|paid in advance|pay (up ?front|in advance)|upfront payment)\b/.test(t)) return true;
  return YEARLY.test(t) && !MONTHLY.test(t) && !WEEKLY.test(t);
}

/** A sentence that makes phone or mail the only way to cancel. */
export function isPhoneOrMailOnly(text: string): boolean {
  const t = lpNormalize(text);
  return cancelVia(t) !== null && !hasAltChannel(t) && !companyTerminates(t);
}

export function runRules(paragraphs: Paragraph[]): RuleHit[] {
  return paragraphs.flatMap(matchParagraph);
}

/** Best hit per category: highest severity, then earliest. Sorted by CATEGORY_ORDER. */
export function bestPerCategory<T extends { category: Category; severity: Severity }>(hits: T[]): T[] {
  const best = new Map<Category, T>();
  for (const h of hits) {
    const b = best.get(h.category);
    if (!b || SEVERITY_RANK[h.severity] > SEVERITY_RANK[b.severity]) best.set(h.category, h);
  }
  return CATEGORY_ORDER.filter((c) => best.has(c)).map((c) => best.get(c)!);
}
