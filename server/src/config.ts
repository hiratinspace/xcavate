export type LlmProvider = "mock" | "anthropic";

export interface Config {
  port: number;
  llmProvider: LlmProvider;
  llmApiKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  dbPath: string;
  rateLimitPerMin: number;
  store: "auto" | "sqlite" | "memory";
  /** Let client POSTs write the shared per-domain report. Off by default: client text is unverified. */
  publishClientReports: boolean;
  /** Express "trust proxy" hop count for the rate limiter's client IP. 0 = off (default). */
  trustProxy: number;
}

export const DEFAULT_MODEL = "claude-sonnet-5-5";

/**
 * One deadline for every model call of a request (SDK retries and the app retry included).
 * Keep it below the extension's ANALYZE_TIMEOUT_MS (25 s) so the server always answers first,
 * with its rules-only fallback, instead of the client giving up.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 20_000;

function int(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read configuration from the environment (call after dotenv has loaded). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.LLM_PROVIDER ?? "mock").trim().toLowerCase();
  const store = (env.STORE ?? "auto").trim().toLowerCase();
  return {
    port: int(env.PORT, 8787),
    llmProvider: provider === "anthropic" ? "anthropic" : "mock",
    llmApiKey: (env.LLM_API_KEY ?? "").trim(),
    llmModel: (env.LLM_MODEL ?? "").trim() || DEFAULT_MODEL,
    llmTimeoutMs: int(env.LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS),
    dbPath: (env.DB_PATH ?? "").trim() || "./data/xcavate.db",
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 30),
    store: store === "sqlite" || store === "memory" ? store : "auto",
    publishClientReports: (env.PUBLISH_CLIENT_REPORTS ?? "").trim().toLowerCase() === "true",
    trustProxy: Math.min(10, Math.max(0, Number.parseInt(env.TRUST_PROXY ?? "0", 10) || 0)),
  };
}
