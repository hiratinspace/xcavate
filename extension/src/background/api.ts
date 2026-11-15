import { ReportSchema, type AnalyzeRequest, type Report } from "@xcavate/shared";
import { buildAnalyzeRequest } from "../lib/request";

/** Backend calls (BUILD_PLAN 6.2). Only the AnalyzeRequest fields are ever sent. */

/** Above the server's 20 s model deadline (server/src/config.ts) with margin, so the server's fallback arrives. */
export const ANALYZE_TIMEOUT_MS = 25_000;
export const LOOKUP_TIMEOUT_MS = 1_500;
export const HEALTH_TIMEOUT_MS = 1_500;

type FetchFn = typeof fetch;

/** Runs `fn` with a signal that aborts after `ms` or when `outer` aborts (the AI check was turned off). */
async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const onOuter = () => ctrl.abort();
  if (outer?.aborted) ctrl.abort();
  outer?.addEventListener("abort", onOuter, { once: true });
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
    outer?.removeEventListener("abort", onOuter);
  }
}

export async function postAnalyze(
  apiBase: string,
  req: AnalyzeRequest,
  { fetchImpl = globalThis.fetch as FetchFn, timeoutMs = ANALYZE_TIMEOUT_MS, signal: outer }: { fetchImpl?: FetchFn; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Report> {
  // Re-copy field by field so nothing outside the contract can leave the browser.
  const body = JSON.stringify(buildAnalyzeRequest(req));
  return withTimeout(timeoutMs, async (signal) => {
    const res = await fetchImpl(apiBase + "/v1/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "omit",
      signal,
    });
    if (!res.ok) throw new Error("backend " + res.status);
    const parsed = ReportSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("invalid report from backend");
    return parsed.data;
  }, outer);
}

/** F-06 instant path: a report someone already produced for this domain, or undefined. */
export async function lookupReport(
  apiBase: string,
  domain: string,
  { fetchImpl = globalThis.fetch as FetchFn, timeoutMs = LOOKUP_TIMEOUT_MS, signal: outer }: { fetchImpl?: FetchFn; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Report | undefined> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(apiBase + "/v1/report?domain=" + encodeURIComponent(domain), {
        credentials: "omit",
        signal,
      });
      if (!res.ok) return undefined;
      const parsed = ReportSchema.safeParse(await res.json());
      return parsed.success ? parsed.data : undefined;
    }, outer);
  } catch {
    return undefined;
  }
}

/**
 * Which model the service runs (GET /healthz answers { ok, llm }). "mock" means the service is the
 * rules engine on purpose, so its rules-only reports are complete results; undefined when unknown.
 */
export async function fetchProvider(
  apiBase: string,
  { fetchImpl = globalThis.fetch as FetchFn, timeoutMs = HEALTH_TIMEOUT_MS, signal: outer }: { fetchImpl?: FetchFn; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | undefined> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(apiBase + "/healthz", { credentials: "omit", signal });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { llm?: unknown };
      return typeof body?.llm === "string" ? body.llm : undefined;
    }, outer);
  } catch {
    return undefined;
  }
}
