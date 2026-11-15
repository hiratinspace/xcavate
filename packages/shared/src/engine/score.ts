import { CATEGORY_ORDER, SEVERITY_CAPS, SEVERITY_RANK } from "../core.js";
import type { AnalyzeRequest, Category, Flag, PolicyKind, Severity, Verdict } from "../core.js";
import { AUTO_CHARGE, isYearlyOrPrepaid } from "./rules.js";
import { lpNormalize } from "./textutil.js";

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
} as const;

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
    return f;
  });
}

/**
 * Verdict (section 6.5 as changed by V-01 and V-02). Only money flags count:
 * red = any high; yellow = any medium or 2+ low; otherwise
 * green = a terms, refund, subscription (or manually scanned) policy was analysed;
 * partial = something was read, but none of those (e.g. only the privacy page);
 * unknown = nothing could be read.
 */
export function computeVerdict(flags: Flag[], analyzedKinds: PolicyKind[]): Verdict {
  const money = flags.filter(isMoneyFlag);
  if (money.some((f) => f.severity === "high")) return "red";
  if (money.some((f) => f.severity === "medium")) return "yellow";
  if (money.filter((f) => f.severity === "low").length >= 2) return "yellow";
  if (analyzedKinds.length === 0) return "unknown";
  if (analyzedKinds.some((k) => TERMS_LIKE.has(k))) return "green";
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
