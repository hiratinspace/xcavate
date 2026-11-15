import { CategorySchema } from "@xcavate/shared";

/**
 * Hand-written JSON Schemas for structured outputs (output_config.format).
 * The SDK's zodOutputFormat helper needs zod v4 schemas; @xcavate/shared uses zod 3,
 * so these mirror LlmOutputSchema / ChangeBulletsSchema and the response is
 * validated with those zod schemas in code. Every object sets additionalProperties:false
 * and lists all keys as required; optional values are expressed as nullable.
 */

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const nullable = (s: object) => ({ anyOf: [s, { type: "null" }] });

const FINDING_CATEGORIES = CategorySchema.options.filter((c) => c !== "missing_policy");

export const LLM_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "rulesReview", "trial", "cancellation"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "severity", "title", "summary", "costImpact", "paragraphIndex", "quote"],
        properties: {
          category: { type: "string", enum: FINDING_CATEGORIES },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: str,
          summary: str,
          costImpact: nullable(str),
          paragraphIndex: int,
          quote: str,
        },
      },
    },
    // Direction v3: the model's verdict on each rules candidate (validated and bounded by LlmRulesReviewSchema).
    rulesReview: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "action", "severity", "quote", "reason"],
        properties: {
          category: { type: "string", enum: FINDING_CATEGORIES },
          action: { type: "string", enum: ["keep", "demote", "drop"] },
          severity: nullable({ type: "string", enum: ["high", "medium", "low"] }),
          quote: str,
          reason: str,
        },
      },
    },
    trial: nullable({
      type: "object",
      additionalProperties: false,
      required: ["lengthDays", "priceAfter", "billingPeriod", "quote"],
      properties: {
        lengthDays: nullable(int),
        priceAfter: nullable(str),
        billingPeriod: nullable({ type: "string", enum: ["week", "month", "year"] }),
        quote: nullable(str),
      },
    }),
    cancellation: nullable({
      type: "object",
      additionalProperties: false,
      required: ["method", "steps", "noticeDays", "contact", "quote"],
      properties: {
        method: { type: "string", enum: ["online", "email", "phone", "mail", "unknown"] },
        steps: { type: "array", items: str },
        noticeDays: nullable(int),
        contact: nullable(str),
        quote: nullable(str),
      },
    }),
  },
} as const;

export const CHANGE_BULLETS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bullets"],
  properties: { bullets: { type: "array", items: str } },
} as const;
