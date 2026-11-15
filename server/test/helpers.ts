import type { AnalyzeRequest, LlmOutput } from "@xcavate/shared";
import { LlmError } from "../src/llm/client.js";
import type { ChangeInput, LlmClient, LlmPolicyInput } from "../src/llm/client.js";
import { MemoryStore } from "../src/store/memory.js";

export const FILLER =
  "Our team works hard to bring you a great selection and friendly service. We were founded by people who love good design and fair dealing. ".repeat(4);

/** A policy body long enough to count as readable (500+ chars). */
export function policyText(...paragraphs: string[]): string {
  return ["About us. " + FILLER, ...paragraphs].join("\n\n");
}

export function request(text: string, extra: Partial<AnalyzeRequest> = {}): AnalyzeRequest {
  return {
    pageUrl: "https://shop.example.com/checkout",
    pageType: "checkout",
    linksFound: 1,
    policies: [{ url: "https://shop.example.com/terms", kind: "terms", text }],
    ...extra,
  };
}

/** Scriptable LLM for tests: records calls, returns or throws what it is told. */
export class FakeLlm implements LlmClient {
  readonly provider = "anthropic" as const;
  calls = 0;
  lastInput: LlmPolicyInput[] = [];
  constructor(
    public respond: (input: LlmPolicyInput[]) => LlmOutput | Promise<LlmOutput> = () => ({ findings: [], trial: null, cancellation: null }),
    public bullets: (input: ChangeInput) => string[] = () => ["Something changed."],
  ) {}
  async analyze(input: LlmPolicyInput[]): Promise<LlmOutput> {
    this.calls++;
    this.lastInput = input;
    return this.respond(input);
  }
  async summarizeChanges(input: ChangeInput): Promise<string[]> {
    this.calls++;
    return this.bullets(input);
  }
}

export const failingLlm = () =>
  new FakeLlm(
    () => {
      throw new LlmError("network", "offline");
    },
    () => {
      throw new LlmError("network", "offline");
    },
  );

export const memStore = () => new MemoryStore();
