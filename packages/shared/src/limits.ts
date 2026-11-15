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
