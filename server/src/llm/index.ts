import type { Config } from "../config.js";
import { AnthropicLlm } from "./anthropic.js";
import type { LlmClient } from "./client.js";
import { MockLlm } from "./mock.js";

export * from "./client.js";
export { AnthropicLlm } from "./anthropic.js";
export { MockLlm } from "./mock.js";

/** Pick the LLM from config. A missing key for "anthropic" falls back to mock rather than crashing. */
export function createLlm(config: Pick<Config, "llmProvider" | "llmApiKey" | "llmModel" | "llmTimeoutMs">): LlmClient {
  if (config.llmProvider === "anthropic" && config.llmApiKey) {
    return new AnthropicLlm({ apiKey: config.llmApiKey, model: config.llmModel, timeoutMs: config.llmTimeoutMs });
  }
  return new MockLlm();
}
