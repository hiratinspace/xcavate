import type { LlmOutput, PolicyKind } from "@xcavate/shared";

/** One policy as the model sees it: kept paragraphs with request-wide ids. */
export interface LlmPolicyInput {
  url: string;
  kind: PolicyKind;
  /** `id` is unique across the whole request, so findings can be mapped back to a policy. */
  paragraphs: { id: number; text: string }[];
}

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
