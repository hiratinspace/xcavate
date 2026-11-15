import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_TIMEOUT_MS, loadConfig } from "../src/config.js";
import { AnthropicLlm, MIN_RETRY_MS, SDK_MAX_RETRIES } from "../src/llm/anthropic.js";
import { DEFAULT_DEADLINE_MS } from "../src/pipeline/run.js";

/** Reliability review item 2: one model deadline that fits inside the extension's client timeout. */

const GOOD = { findings: [], trial: null, cancellation: null };
const message = (text: string, stop_reason = "end_turn") => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "m",
  content: [{ type: "text", text }],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const INPUT = [{ url: "https://x.test/terms", kind: "terms" as const, paragraphs: [{ id: 0, text: "All sales are final." }] }];

/** Every call answers after `delayMs` with the given bodies in turn. */
function slowFetch(delayMs: number, bodies: unknown[]) {
  let i = 0;
  const fn = (async (_u: string, init: RequestInit) => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, delayMs);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, count: () => i };
}

describe("model timeout budget", () => {
  it("defaults to 20 s, below the extension's 25 s analyze timeout with margin", async () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(20_000);
    expect(loadConfig({}).llmTimeoutMs).toBe(20_000);
    expect(loadConfig({ LLM_TIMEOUT_MS: "15000" }).llmTimeoutMs).toBe(15_000);
    expect(DEFAULT_DEADLINE_MS).toBe(DEFAULT_LLM_TIMEOUT_MS);
    const { ANALYZE_TIMEOUT_MS } = await import("../../extension/src/background/api.js");
    expect(ANALYZE_TIMEOUT_MS - DEFAULT_LLM_TIMEOUT_MS).toBeGreaterThanOrEqual(4_000);
  });

  it("SDK retries stay small", () => {
    expect(SDK_MAX_RETRIES).toBeLessThanOrEqual(1);
    expect(MIN_RETRY_MS).toBe(6_000);
  });

  it("skips the app-level retry when too little of the deadline is left", async () => {
    // Deadline 1000 ms: a retry needs min(6000, 500) = 500 ms. The first answer (invalid) takes 600 ms.
    const f = slowFetch(600, [message("not json")]);
    const llm = new AnthropicLlm({ apiKey: "k", model: "m", timeoutMs: 1000, fetch: f.fn, baseURL: "http://llm.test" });
    const t0 = Date.now();
    await expect(llm.analyze(INPUT)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(f.count()).toBe(1);
    expect(Date.now() - t0).toBeLessThan(950);
  });

  it("still retries when there is time for it", async () => {
    const f = slowFetch(50, [message('{"findi', "max_tokens"), message(JSON.stringify(GOOD))]);
    const llm = new AnthropicLlm({ apiKey: "k", model: "m", timeoutMs: 2000, fetch: f.fn, baseURL: "http://llm.test" });
    await expect(llm.analyze(INPUT)).resolves.toMatchObject({ findings: [] });
    expect(f.count()).toBe(2);
  });
});
