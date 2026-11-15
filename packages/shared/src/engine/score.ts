import { CATEGORY_ORDER, SEVERITY_CAPS, SEVERITY_RANK } from "../core.js";
import type { AnalyzeRequest, Category, Flag, PolicyKind, Severity, Verdict } from "../core.js";
import {
  AUTO_CHARGE,
  cancelFrictionSeverity,
  cancelVia,
  hasAltChannel,
  hasSelfServe,
  isNoncompliantReturnFee,
  isPartialPeriodNoRefund,
  isYearlyOrPrepaid,
  promisesNotice,
  renewalPeriodOf,
} from "./rules.js";
import { lpNormalize, splitSentences } from "./textutil.js";

/**
 * Categories reported for information only (V-01): they never change the verdict and sort
 * after every money category. Their wording still appears in the popup.
 */
export const NON_VERDICT_CATEGORIES: ReadonlySet<Category> = new Set<Category>(["arbitration", "data_sharing"]);

export const isMoneyFlag = (f: Pick<Flag, "category">) => !NON_VERDICT_CATEGORIES.has(f.category);

/** Policy kinds whose reading can justify a green verdict (V-02). "other" is a manual scan of a policy page. */
const TERMS_LIKE: ReadonlySet<PolicyKind> = new Set<PolicyKind>(["terms", "refund", "subscription", "other"]);

/** Lower a severity to its category cap (section 6.5). Never raises it. */
export function capSeverity(category: Flag["category"], severity: Severity): Severity {
  const cap = SEVERITY_CAPS[category];
  return SEVERITY_RANK[severity] > SEVERITY_RANK[cap] ? cap : severity;
}

export function applyCaps(flags: Flag[]): Flag[] {
  return flags.map((f) => ({ ...f, severity: capSeverity(f.category, f.severity) }));
}

/** Money categories first, then severity desc, then category order (section 6.1). */
export function sortFlags(flags: Flag[]): Flag[] {
  return [...flags].sort(
    (a, b) =>
      Number(!isMoneyFlag(a)) - Number(!isMoneyFlag(b)) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
}

/** Facts about the whole document set that decide how harsh a renewal or trial is (V-01). */
export interface CalibrationContext {
  /** The policies offer an online / account / app / email way to cancel. */
  onlineCancel: boolean;
  /** Cancelling is phone/mail-only or needs 30+ days' notice (a high cancellation_friction flag). */
  harshCancel: boolean;
  /** The policies say no reminder is sent before a charge. */
  noReminder: boolean;
  /** The price can change (a price_change flag), so a renewal can cost more. */
  priceCanRise: boolean;
}

export const CONTEXT_TEXT = {
  renewalOnline: "Normal for subscriptions: it renews until you cancel, and the terms say you can cancel online.",
  renewalPlain: "Normal for subscriptions: it keeps renewing until you cancel.",
  trialNormal: "Common for free trials: it turns into a paid plan unless you cancel before the trial ends.",
  partialPeriod: "Normal for subscriptions: cancelling stops the next charge.",
} as const;

const lowerOf = (s: Severity): Severity => (s === "high" ? "medium" : "low");
const minSev = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b);

/**
 * Severity facts decided in code from the quote and its paragraph, for rules and model flags alike
 * (direction v3). Each cap can only lower a severity, and when it does it also replaces the
 * wording with template text, so a headline never says more than its quote.
 */
export function capByText(f: Flag, paragraph: string): Flag {
  const para = lpNormalize(paragraph);
  switch (f.category) {
    case "cancellation_friction": {
      let cap = cancelFrictionSeverity(f.quote);
      // "Cancel by calling us" in a paragraph that says it is the only way, with no other channel.
      if (cap === "medium" && cancelVia(lpNormalize(f.quote)) && !hasAltChannel(para) && /\b(only|solely|exclusively)\b/.test(para)) cap = "high";
      if (SEVERITY_RANK[f.severity] <= SEVERITY_RANK[cap]) return f;
      const selfServe = hasSelfServe(lpNormalize(f.quote));
      return {
        ...f,
        severity: cap,
        title: selfServe ? "Cancelling has extra steps" : "Cancel through customer support",
        summary: selfServe
          ? "The terms describe how to cancel; read the steps before you sign up."
          : "You may have to contact the company to cancel instead of doing it yourself.",
      };
    }
    case "price_change": {
      if (f.severity !== "high" || !(promisesNotice(lpNormalize(f.quote)) || promisesNotice(para))) return f;
      return {
        ...f,
        severity: "medium",
        title: "Price can change",
        summary: "They can raise what you pay; the terms say they will tell you before it happens.",
      };
    }
    case "no_refund": {
      if (!isPartialPeriodNoRefund(f.quote)) return f;
      return {
        ...f,
        severity: "low",
        title: "No refunds for part of a billing period",
        summary: "If you cancel mid-period, you keep access until the period ends but get no money back for it.",
        context: CONTEXT_TEXT.partialPeriod,
      };
    }
    case "return_cost": {
      if (f.severity === "low" || !isNoncompliantReturnFee(f.quote)) return f;
      return {
        ...f,
        severity: "low",
        title: "Fee on returns that break the rules",
        summary: "A fee can apply to returns that do not meet the return policy.",
      };
    }
    case "auto_renewal": {
      // The headline's period must be the one the quote states ("monthly or annually" is not "every year").
      const claimed = /\b(year|annual)/i.test(f.title) ? "year" : /\bmonth/i.test(f.title) ? "month" : /\bweek/i.test(f.title) ? "week" : undefined;
      const stated = renewalPeriodOf(f.quote);
      if (!claimed || stated === " every " + claimed) return f;
      return { ...f, title: "Renews automatically" + stated, summary: "Your plan keeps charging you" + stated + " until you cancel it." };
    }
    default:
      return f;
  }
}

/**
 * V-01 recalibration, applied in code to rules and model flags alike:
 * - auto_renewal: high with harsh cancellation; medium when yearly/prepaid with no online
 *   cancel path, or when the price can rise; otherwise low ("normal for subscriptions").
 * - trial_converts: high when it converts automatically AND (to a yearly/prepaid plan, OR no
 *   reminder is sent, OR cancelling is harsh); otherwise medium.
 * `context` is template text only, never model wording.
 */
export function recalibrate(flags: Flag[], ctx: CalibrationContext): Flag[] {
  return flags.map((f) => {
    if (f.category === "auto_renewal") {
      const yearly = isYearlyOrPrepaid(f.quote);
      let severity: Severity;
      if (ctx.harshCancel) severity = "high";
      else if ((yearly && !ctx.onlineCancel) || ctx.priceCanRise) severity = "medium";
      else severity = "low";
      const out: Flag = { ...f, severity };
      if (severity === "low") out.context = ctx.onlineCancel ? CONTEXT_TEXT.renewalOnline : CONTEXT_TEXT.renewalPlain;
      else delete out.context;
      return out;
    }
    if (f.category === "trial_converts") {
      const q = lpNormalize(f.quote);
      const automatic = AUTO_CHARGE.test(q) || /\bconvert/.test(q) || f.severity === "high";
      const harsh = isYearlyOrPrepaid(f.quote) || ctx.noReminder || ctx.harshCancel;
      const severity: Severity = automatic && harsh ? "high" : "medium";
      const out: Flag = { ...f, severity };
      if (severity === "medium" && automatic) out.context = CONTEXT_TEXT.trialNormal;
      else delete out.context;
      return out;
    }
    if (f.category === "no_refund" && isPartialPeriodNoRefund(f.quote)) {
      return { ...f, severity: minSev(f.severity, "low"), context: CONTEXT_TEXT.partialPeriod };
    }
    return f;
  });
}

/** A sentence that states a money term: refunds or returns, renewal or billing, subscription price, cancelling a plan, a trial. */
const MONEY_CLAUSE =
  /\b(refund\w*|money[- ]back|restocking|exchanges?)\b|\breturns? (are|is|must|may|can|within|policy|window|shipping)\b|\breturn (an|the|your|any) (item|order|product|purchase)s?\b|\b(auto-?renew\w*|renew(s|al|als|ed)?)\b|\bbill(ed|ing)? (you|your|monthly|annually|weekly|each|every|in advance)\b|\bbilling (cycle|period|date)s?\b|\b(subscription|membership) (fees?|prices?|plans?|terms?)\b|\bcancel\w* (your |the |a |any )?(subscription|membership|plan|order|purchase|service)s?\b|\b(free )?trial (period|ends|expires)\b|\b(charge|charged) (to )?(you|your)\b|\bprices? (of|for|are|is|may|can|will)\b/;
/** "Refunds are governed by our Refund Policy": a pointer to another page, not the term itself. */
const POINTER = /\b(governed by|see|refer to|set out in|set forth in|described in|explained in|found in|available in|available at) (our|the|a|its|any)\b[^.]{0,60}\b(policy|policies|terms|agreement)\b/;

/**
 * The analysed text actually states a money term (direction v3): at least one sentence about refunds,
 * returns, renewal, billing, subscription prices, cancelling a plan or a trial, that is not only a
 * pointer to another page. A general terms of use whose billing terms live elsewhere fails this,
 * so it cannot give a green verdict.
 */
export function coversMoneyTopics(text: string): boolean {
  for (const para of text.split(/\n\s*\n/)) {
    for (const s of splitSentences(para)) {
      const t = lpNormalize(s);
      if (MONEY_CLAUSE.test(t) && !POINTER.test(t)) return true;
    }
  }
  return false;
}

/**
 * Verdict (section 6.5 as changed by V-01, V-02 and direction v3). Only money flags count:
 * red = any high; yellow = any medium or 2+ low; otherwise
 * green = a terms, refund, subscription (or manually scanned) policy was analysed AND what was
 *   analysed covers money topics (`moneyCovered`; undefined keeps the older kind-only rule);
 * partial = something was read, but it does not cover billing or refunds (e.g. only the privacy
 *   page, or a general terms of use whose billing terms live elsewhere);
 * unknown = nothing could be read.
 */
export function computeVerdict(flags: Flag[], analyzedKinds: PolicyKind[], moneyCovered?: boolean): Verdict {
  const money = flags.filter(isMoneyFlag);
  if (money.some((f) => f.severity === "high")) return "red";
  if (money.some((f) => f.severity === "medium")) return "yellow";
  if (money.filter((f) => f.severity === "low").length >= 2) return "yellow";
  if (analyzedKinds.length === 0) return "unknown";
  if (analyzedKinds.some((k) => TERMS_LIKE.has(k)) && moneyCovered !== false) return "green";
  return "partial";
}

/**
 * missing_policy (section 7.4 step 7): a checkout/sign-up page with no policy links.
 * Not added when a policy was still analysed (e.g. found at a well-known path).
 */
export function needsMissingPolicy(req: Pick<AnalyzeRequest, "pageType" | "linksFound">, analyzedCount: number): boolean {
  return req.pageType !== "none" && req.linksFound === 0 && analyzedCount === 0;
}

export const MISSING_POLICY_FLAG: Flag = {
  id: "missing_policy:e3b0c442",
  category: "missing_policy",
  severity: "medium",
  title: "No terms or refund policy found",
  summary: "This page links to no terms or refund policy, so you cannot check the rules before you pay.",
  quote: "",
  policyUrl: "",
  paragraphIndex: -1,
  source: "rules",
};
