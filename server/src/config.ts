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
}

export const DEFAULT_MODEL = "claude-haiku-5-5";

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
    llmTimeoutMs: int(env.LLM_TIMEOUT_MS, 12_000),
    dbPath: (env.DB_PATH ?? "").trim() || "./data/xcavate.db",
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 30),
    store: store === "sqlite" || store === "memory" ? store : "auto",
    publishClientReports: (env.PUBLISH_CLIENT_REPORTS ?? "").trim().toLowerCase() === "true",
  };
}
