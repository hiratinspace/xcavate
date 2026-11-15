import type { LlmOutput } from "@xcavate/shared";
import type { LlmPolicyInput } from "@xcavate/shared/engine";

/** One policy as the model sees it (defined with the shared engine, which builds it). */
export type { LlmPolicyInput } from "@xcavate/shared/engine";

export interface ChangeInput {
  policyUrl: string;
  added: string[];
  removed: string[];
}

export interface LlmCallOptions {
  signal?: AbortSignal;
}

export interface LlmClient {
  readonly provider: "mock" | "anthropic";
  /** Model id, part of the cache key so a model change never serves older results. */
  readonly model: string;
  /** Findings + trial + cancellation. `paragraphIndex` in findings is the request-wide paragraph id. */
  analyze(policies: LlmPolicyInput[], opts?: LlmCallOptions): Promise<LlmOutput>;
  /** At most 3 plain-English bullets about what changed. */
  summarizeChanges(input: ChangeInput, opts?: LlmCallOptions): Promise<string[]>;
}

export type LlmErrorKind =
  | "config"
  | "timeout"
  | "network"
  | "rate_limited"
  | "api"
  | "refusal"
  | "max_tokens"
  | "invalid_output";

/** The only error type LLM clients throw; the pipeline catches it and falls back to rules. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
}
