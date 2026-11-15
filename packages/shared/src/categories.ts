import type { Category, Severity } from "./types.js";

/** Display + sort order (section 6.1). */
export const CATEGORY_ORDER: readonly Category[] = [
  "auto_renewal",
  "trial_converts",
  "cancellation_friction",
  "termination_fee",
  "no_refund",
  "return_cost",
  "price_change",
  "extra_fees",
  "arbitration",
  "data_sharing",
  "missing_policy",
] as const;

export const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

/** Maximum severity per category (section 6.5). Code enforces this, not the model. */
export const SEVERITY_CAPS: Record<Category, Severity> = {
  auto_renewal: "high",
  trial_converts: "high",
  cancellation_friction: "high",
  termination_fee: "high",
  no_refund: "high",
  return_cost: "medium",
  price_change: "high",
  extra_fees: "medium",
  arbitration: "medium",
  data_sharing: "medium",
  missing_policy: "medium",
};

/** One-line meanings, used in the LLM prompt and the UI. */
export const CATEGORY_MEANING: Record<Category, string> = {
  auto_renewal: "renews and charges again unless you cancel",
  trial_converts: "a free or cheap trial turns into a paid plan",
  cancellation_friction: "hard to cancel: phone or mail only, long notice period, must contact support",
  termination_fee: "a fee for leaving or cancelling early",
  no_refund: "no refunds, or refunds heavily limited (store credit only, very short window)",
  return_cost: "restocking fee, or the buyer pays return shipping",
  price_change: "the seller can change the price",
  extra_fees: "service, processing, convenience or other fees beyond price, tax and shipping",
  arbitration: "forced arbitration or a class-action waiver",
  data_sharing: "sells or shares personal data with third parties",
  missing_policy: "no terms or refund policy could be found",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  auto_renewal: "Auto-renewal",
  trial_converts: "Trial converts to paid",
  cancellation_friction: "Hard to cancel",
  termination_fee: "Early termination fee",
  no_refund: "Limited refunds",
  return_cost: "Return costs",
  price_change: "Price can change",
  extra_fees: "Extra fees",
  arbitration: "Forced arbitration",
  data_sharing: "Data sharing",
  missing_policy: "Missing policy",
};

/** Severity rubric text for the LLM prompt (section 6.5, recalibrated in direction v2 / V-01). Code still decides in server score.ts. */
export const SEVERITY_RUBRIC: Record<Category, { high?: string; medium?: string; low?: string }> = {
  auto_renewal: {
    high: "renewal combined with harsh terms: cancel only by phone or mail, or 30+ days' notice",
    medium: "yearly or prepaid renewal with no online way to cancel, or the price after renewal can rise",
    low: "plain monthly or yearly renewal you can cancel online (normal for subscriptions)",
  },
  trial_converts: {
    high: "converts automatically AND to a yearly/prepaid plan, or with no reminder, or cancel only by phone/mail",
    medium: "a normal free trial that converts to a monthly plan you can cancel online",
  },
  cancellation_friction: { high: "phone or mail only, or notice of 30 days or more", medium: "must contact support" },
  termination_fee: { high: "any fee for leaving early" },
  no_refund: { high: "'all sales final' or no refunds", medium: "store credit only, or a refund window of 14 days or less" },
  return_cost: { medium: "restocking fee, or the buyer pays return shipping" },
  price_change: { high: "price can change without notice", medium: "price can change with notice" },
  extra_fees: { medium: "named fees beyond price, tax and shipping" },
  arbitration: { low: "forced arbitration or class-action waiver (reported for information, does not affect the verdict)" },
  data_sharing: {
    medium: "sells personal data (reported for information, does not affect the verdict)",
    low: "shares with partners (for information only)",
  },
  missing_policy: { medium: "always" },
};
