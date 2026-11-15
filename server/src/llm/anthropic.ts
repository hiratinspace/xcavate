import Anthropic from "@anthropic-ai/sdk";
import { ChangeBulletsSchema, LlmOutputSchema } from "@xcavate/shared";
import type { LlmOutput } from "@xcavate/shared";
import type { z } from "zod";
import { LlmError } from "./client.js";
import type { ChangeInput, LlmCallOptions, LlmClient, LlmPolicyInput } from "./client.js";
import { CHANGE_SYSTEM_PROMPT, SYSTEM_PROMPT, buildChangeMessage, buildUserMessage } from "./prompt.js";
import { CHANGE_BULLETS_JSON_SCHEMA, LLM_OUTPUT_JSON_SCHEMA } from "./schema.js";

/** Room for adaptive thinking plus the JSON answer; Haiku 5.5 can spend thousands of tokens thinking. */
export const ANALYZE_MAX_TOKENS = 16_000;
export const CHANGE_MAX_TOKENS = 4_096;

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** For tests: a custom fetch. */
  fetch?: typeof fetch;
  baseURL?: string;
}

/**
 * Claude via the official SDK with structured outputs (output_config.format).
 * No temperature/top_p/top_k (current models reject them), no prefill, no thinking
 * config (adaptive by default); effort "low" for latency. One retry on invalid or truncated output;
 * an overall deadline of timeoutMs covers both attempts.
 */
export class AnthropicLlm implements LlmClient {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private client: Anthropic;

  constructor(private readonly opts: AnthropicOptions) {
    if (!opts.apiKey) throw new LlmError("config", "LLM_API_KEY is not set");
    this.model = opts.model;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs,
      maxRetries: 1,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  analyze(policies: LlmPolicyInput[], callOpts?: LlmCallOptions): Promise<LlmOutput> {
    return this.structured(SYSTEM_PROMPT, buildUserMessage(policies), LLM_OUTPUT_JSON_SCHEMA, LlmOutputSchema, ANALYZE_MAX_TOKENS, callOpts);
  }

  async summarizeChanges(input: ChangeInput, callOpts?: LlmCallOptions): Promise<string[]> {
    const out = await this.structured(
      CHANGE_SYSTEM_PROMPT,
      buildChangeMessage(input),
      CHANGE_BULLETS_JSON_SCHEMA,
      ChangeBulletsSchema,
      CHANGE_MAX_TOKENS,
      callOpts,
    );
    return out.bullets.map((b) => b.trim()).filter(Boolean).slice(0, 3);
  }

  private async structured<T>(
    system: string,
    user: string,
    jsonSchema: object,
    zodSchema: z.ZodType<T>,
    maxTokens: number,
    callOpts?: LlmCallOptions,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = callOpts?.signal ? AbortSignal.any([deadline, callOpts.signal]) : deadline;
    let lastError: LlmError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.once(system, user, jsonSchema, zodSchema, maxTokens, signal);
      } catch (e) {
        const err = toLlmError(e, deadline.aborted);
        // Retry once, and only for output we could not use (invalid, or cut off at max_tokens because
        // adaptive thinking used the budget); timeouts and API errors fall back at once.
        if ((err.kind !== "invalid_output" && err.kind !== "max_tokens") || signal.aborted) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new LlmError("invalid_output", "invalid output");
  }

  private async once<T>(
    system: string,
    user: string,
    jsonSchema: object,
    zodSchema: z.ZodType<T>,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await this.client.messages.create(
      {
        model: this.opts.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: jsonSchema as Record<string, unknown> },
        },
      },
      { signal },
    );
    if (response.stop_reason === "refusal") throw new LlmError("refusal", "model refused");
    if (response.stop_reason === "max_tokens") throw new LlmError("max_tokens", "output cut off at max_tokens");
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return parseStructured(text, zodSchema);
  }
}

/** Parse and validate structured-output text (exported for tests). */
export function parseStructured<T>(text: string, zodSchema: z.ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Last-resort fallback: a fenced JSON block.
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (!m) throw new LlmError("invalid_output", "response is not JSON");
    try {
      json = JSON.parse(m[1]);
    } catch {
      throw new LlmError("invalid_output", "response is not JSON");
    }
  }
  const parsed = zodSchema.safeParse(json);
  if (!parsed.success) throw new LlmError("invalid_output", "response does not match the schema");
  return parsed.data;
}

/** Map SDK errors to LlmError without copying response bodies (they could echo input). */
export function toLlmError(e: unknown, deadlineHit = false): LlmError {
  if (e instanceof LlmError) return e;
  if (deadlineHit) return new LlmError("timeout", "LLM deadline exceeded");
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new LlmError("timeout", "LLM request timed out");
  if (e instanceof Anthropic.APIUserAbortError) return new LlmError("timeout", "LLM request aborted");
  if (e instanceof Anthropic.APIConnectionError) return new LlmError("network", "could not reach the LLM API");
  if (e instanceof Anthropic.RateLimitError) return new LlmError("rate_limited", "LLM rate limited", 429);
  if (e instanceof Anthropic.APIError) return new LlmError("api", "LLM API error " + (e.status ?? ""), e.status);
  if (e instanceof Error && e.name === "AbortError") return new LlmError("timeout", "LLM request aborted");
  return new LlmError("api", "unexpected LLM client error");
}
