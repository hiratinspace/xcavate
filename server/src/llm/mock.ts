import type { LlmOutput } from "@xcavate/shared";
import { bestPerCategory, extractCancellation, extractTrial, ruleChangeBullets, runRules } from "@xcavate/shared/engine";
import type { Paragraph } from "@xcavate/shared/engine";
import type { ChangeInput, LlmClient, LlmPolicyInput } from "./client.js";

/**
 * Deterministic offline stand-in for the model (LLM_PROVIDER=mock). It answers
 * in the same shape as the real model, deriving findings from the rules engine over
 * exactly the paragraphs the model would see, so the whole pipeline (prompt input,
 * id mapping, verification, merge) runs with no key and no network.
 */
export class MockLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly model = "mock-rules";
  calls = 0;

  async analyze(policies: LlmPolicyInput[]): Promise<LlmOutput> {
    this.calls++;
    const paragraphs: Paragraph[] = policies.flatMap((p) => p.paragraphs.map((x) => ({ index: x.id, text: x.text })));
    const findings = bestPerCategory(runRules(paragraphs)).map((h) => ({
      category: h.category,
      severity: h.severity,
      title: h.title,
      summary: h.summary,
      costImpact: h.costImpact ?? null,
      paragraphIndex: h.paragraphIndex,
      quote: h.quote,
    }));
    const trial = extractTrial(paragraphs);
    const cancel = extractCancellation(paragraphs);
    return {
      findings,
      // The mock is the rules engine: it has no independent opinion on the rules candidates.
      rulesReview: [],
      trial: trial
        ? {
            lengthDays: trial.lengthDays ?? null,
            priceAfter: trial.priceAfter ?? null,
            billingPeriod: trial.billingPeriod ?? null,
            quote: trial.quote ?? null,
          }
        : null,
      cancellation: cancel
        ? {
            method: cancel.method,
            steps: cancel.steps,
            noticeDays: cancel.noticeDays ?? null,
            contact: cancel.contact ?? null,
            quote: cancel.quote ?? null,
          }
        : null,
    };
  }

  async summarizeChanges(input: ChangeInput): Promise<string[]> {
    this.calls++;
    return ruleChangeBullets(input.added, input.removed);
  }
}
