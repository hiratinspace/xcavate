import type { Report } from "./types.js";

const STREAMNEST_TERMS = "http://streamnest.localhost:4000/terms";
const STREAMNEST_SUB = "http://streamnest.localhost:4000/subscription";

/** Sample reports for UI work (S-02). They pass ReportSchema. */
export const SAMPLE_REPORT_RED: Report = {
  schemaVersion: 1,
  domain: "streamnest.localhost:4000",
  verdict: "red",
  flags: [
    {
      id: "trial_converts:1a2b3c4d",
      category: "trial_converts",
      severity: "high",
      title: "Free trial turns into a paid plan",
      summary: "After 7 days you are charged $14.99 a month automatically unless you cancel first.",
      costImpact: "$14.99 every month after the trial",
      quote:
        "At the end of your 7-day free trial, your membership will automatically convert to a paid monthly plan and you will be charged $14.99 per month.",
      policyUrl: STREAMNEST_SUB,
      paragraphIndex: 3,
      source: "both",
    },
    {
      id: "auto_renewal:5e6f7a8b",
      category: "auto_renewal",
      severity: "high",
      title: "Renews automatically every month",
      summary: "Your plan keeps charging you every month until you cancel it.",
      costImpact: "$14.99 per month",
      quote: "Your subscription renews automatically each month until you cancel.",
      policyUrl: STREAMNEST_SUB,
      paragraphIndex: 4,
      source: "rules",
    },
    {
      id: "cancellation_friction:9c0d1e2f",
      category: "cancellation_friction",
      severity: "high",
      title: "Cancel by phone only, 30 days' notice",
      summary: "You can only cancel by calling, and you must give 30 days' notice.",
      quote: "Cancellations must be made by telephone at 1-800-555-0199 and require at least 30 days' notice before your next billing date.",
      policyUrl: STREAMNEST_TERMS,
      paragraphIndex: 11,
      source: "llm",
    },
    {
      id: "arbitration:3a4b5c6d",
      category: "arbitration",
      severity: "low",
      title: "Disputes go to private arbitration",
      summary: "You give up the right to sue in court or join a class action.",
      quote: "You agree to resolve any dispute through binding individual arbitration and waive any right to a class action.",
      policyUrl: STREAMNEST_TERMS,
      paragraphIndex: 18,
      source: "rules",
    },
  ],
  trial: {
    lengthDays: 7,
    priceAfter: "$14.99",
    billingPeriod: "month",
    quote:
      "At the end of your 7-day free trial, your membership will automatically convert to a paid monthly plan and you will be charged $14.99 per month.",
  },
  cancellation: {
    method: "phone",
    steps: ["Call 1-800-555-0199 (Mon to Fri, 9am to 5pm)", "Ask to cancel your membership", "Give at least 30 days' notice"],
    noticeDays: 30,
    contact: "1-800-555-0199",
    quote: "Cancellations must be made by telephone at 1-800-555-0199 and require at least 30 days' notice before your next billing date.",
  },
  policies: [
    { url: STREAMNEST_SUB, kind: "subscription", textHash: "a".repeat(64), status: "analyzed" },
    { url: STREAMNEST_TERMS, kind: "terms", textHash: "b".repeat(64), status: "analyzed" },
  ],
  stats: { droppedUnverified: 1, usedLlm: true, ms: 2140 },
  cached: false,
  generatedAt: "2026-11-14T12:00:00.000Z",
};

export const SAMPLE_REPORT_GREEN: Report = {
  schemaVersion: 1,
  domain: "fairbox.localhost:4000",
  verdict: "green",
  flags: [],
  policies: [
    { url: "http://fairbox.localhost:4000/refunds", kind: "refund", textHash: "c".repeat(64), status: "analyzed" },
    { url: "http://fairbox.localhost:4000/terms", kind: "terms", textHash: "d".repeat(64), status: "analyzed" },
  ],
  stats: { droppedUnverified: 0, usedLlm: true, ms: 1830 },
  cached: false,
  generatedAt: "2026-11-14T12:00:00.000Z",
};
