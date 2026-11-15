import type { Category } from "./types.js";

/**
 * Per-category keyword lists for the paragraph prefilter (section 7.4 step 2).
 * Lower-case; matched as substrings against lower-cased, normalised paragraph text.
 * Keep broad: the prefilter decides what the LLM sees, so missing a word hides a clause.
 */
export const KEYWORDS: Record<Exclude<Category, "missing_policy">, string[]> = {
  auto_renewal: ["auto-renew", "automatically renew", "auto renew", "renews automatically", "renewal", "recurring", "until you cancel", "until cancelled", "until canceled", "each billing period", "billing cycle"],
  trial_converts: ["free trial", "trial period", "trial ends", "end of the trial", "end of your trial", "after the trial", "introductory", "promotional period", "converts"],
  cancellation_friction: ["cancel", "cancellation", "notice", "written notice", "by phone", "telephone", "call us", "certified mail", "customer support", "contact us to"],
  termination_fee: ["early termination", "termination fee", "cancellation fee", "exit fee", "remaining months", "remainder of the term", "liquidated damages"],
  no_refund: ["refund", "non-refundable", "nonrefundable", "all sales final", "all sales are final", "store credit", "money back", "money-back"],
  return_cost: ["restocking", "return shipping", "return postage", "returns", "return label", "return the item"],
  price_change: ["change the price", "change our prices", "price change", "modify the price", "adjust the price", "prices are subject to change", "increase the price", "pricing may change", "new price"],
  extra_fees: ["service fee", "processing fee", "convenience fee", "handling fee", "administrative fee", "surcharge", "booking fee", "platform fee"],
  arbitration: ["arbitration", "arbitrate", "class action", "class-action", "jury trial", "waive your right"],
  data_sharing: ["sell your", "sell personal", "share your", "third part", "advertising partners", "data broker", "personal information", "personal data"],
};
