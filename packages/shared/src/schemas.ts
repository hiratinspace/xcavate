import { z } from "zod";

/** Limits from section 6.2. */
export const LIMITS = {
  maxPolicies: 4,
  maxPolicyChars: 200_000,
  maxBodyBytes: 1_000_000,
  maxQuoteChars: 300,
  maxTitleChars: 60,
  maxSummaryWords: 30,
  minReadableChars: 500,
  prefilterMaxChars: 24_000,
} as const;

export const CategorySchema = z.enum([
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
]);

export const SeveritySchema = z.enum(["high", "medium", "low"]);
export const VerdictSchema = z.enum(["red", "yellow", "green", "unknown"]);
export const PolicyKindSchema = z.enum(["subscription", "refund", "terms", "privacy", "other"]);
export const PageTypeSchema = z.enum(["checkout", "signup", "none"]);

const httpUrl = z
  .string()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), { message: "must be an http(s) URL" });

export const PolicyInputSchema = z.object({
  url: httpUrl,
  kind: PolicyKindSchema,
  text: z.string().max(LIMITS.maxPolicyChars, { message: `policy text must be at most ${LIMITS.maxPolicyChars} chars` }),
  previousHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const AnalyzeRequestSchema = z
  .object({
    pageUrl: httpUrl.refine((u) => !u.includes("?") && !u.includes("#"), {
      message: "pageUrl must not include a query string or hash",
    }),
    pageType: PageTypeSchema,
    linksFound: z.number().int().min(0).max(1000),
    policies: z.array(PolicyInputSchema).max(LIMITS.maxPolicies, { message: `at most ${LIMITS.maxPolicies} policies` }),
  })
  .strict();

export const FlagSchema = z.object({
  id: z.string(),
  category: CategorySchema,
  severity: SeveritySchema,
  title: z.string().max(LIMITS.maxTitleChars),
  summary: z.string(),
  costImpact: z.string().optional(),
  quote: z.string().max(LIMITS.maxQuoteChars),
  policyUrl: z.string(),
  paragraphIndex: z.number().int(),
  source: z.enum(["llm", "rules", "both"]),
});

export const TrialInfoSchema = z.object({
  lengthDays: z.number().int().positive().optional(),
  priceAfter: z.string().optional(),
  billingPeriod: z.enum(["week", "month", "year"]).optional(),
  quote: z.string().optional(),
});

export const CancellationInfoSchema = z.object({
  method: z.enum(["online", "email", "phone", "mail", "unknown"]),
  steps: z.array(z.string()).max(4),
  noticeDays: z.number().int().nonnegative().optional(),
  contact: z.string().optional(),
  quote: z.string().optional(),
});

export const PolicyMetaSchema = z.object({
  url: z.string(),
  kind: PolicyKindSchema,
  textHash: z.string(),
  status: z.enum(["analyzed", "unreadable"]),
});

export const ChangeSummarySchema = z.object({
  policyUrl: z.string(),
  bullets: z.array(z.string()).max(3),
  moneyRelevant: z.boolean(),
});

export const ReportSchema = z.object({
  schemaVersion: z.literal(1),
  domain: z.string(),
  verdict: VerdictSchema,
  flags: z.array(FlagSchema),
  trial: TrialInfoSchema.optional(),
  cancellation: CancellationInfoSchema.optional(),
  changes: z.array(ChangeSummarySchema).optional(),
  policies: z.array(PolicyMetaSchema),
  stats: z.object({ droppedUnverified: z.number().int().nonnegative(), usedLlm: z.boolean(), ms: z.number().nonnegative() }),
  cached: z.boolean(),
  generatedAt: z.string(),
});

// Local-only findings. These never leave the browser.
export const FeeLineSchema = z.object({
  label: z.string(),
  amount: z.number(),
  kind: z.enum(["subtotal", "shipping", "tax", "discount", "extra_fee", "total"]),
});
export const FeeSummarySchema = z.object({ currency: z.string(), lines: z.array(FeeLineSchema), extrasTotal: z.number() });
export const DarkPatternFindingSchema = z.object({
  kind: z.enum(["prechecked_addon", "preselected_subscription"]),
  label: z.string().max(120),
});

/**
 * What the LLM must return (validated with zod, also passed to the API as a structured-output format).
 * Nullable instead of optional so every key is always present (structured outputs require "required").
 */
export const LlmFindingSchema = z.object({
  category: CategorySchema.exclude(["missing_policy"]),
  severity: SeveritySchema,
  title: z.string(),
  summary: z.string(),
  costImpact: z.string().nullable(),
  paragraphIndex: z.number().int(),
  quote: z.string(),
});

export const LlmOutputSchema = z.object({
  findings: z.array(LlmFindingSchema),
  trial: z
    .object({
      lengthDays: z.number().int().nullable(),
      priceAfter: z.string().nullable(),
      billingPeriod: z.enum(["week", "month", "year"]).nullable(),
      quote: z.string().nullable(),
    })
    .nullable(),
  cancellation: z
    .object({
      method: z.enum(["online", "email", "phone", "mail", "unknown"]),
      steps: z.array(z.string()),
      noticeDays: z.number().int().nullable(),
      contact: z.string().nullable(),
      quote: z.string().nullable(),
    })
    .nullable(),
});

export const ChangeBulletsSchema = z.object({ bullets: z.array(z.string()) });

export const GoldenSchema = z.object({
  sites: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      checkoutPath: z.string(),
      verdict: VerdictSchema,
      categories: z.array(CategorySchema),
      /** Categories that must NOT appear (guards against crying wolf). */
      forbidden: z.array(CategorySchema).optional(),
    }),
  ),
});
