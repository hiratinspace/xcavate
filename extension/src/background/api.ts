import { ReportSchema, type AnalyzeRequest, type Report } from "@xcavate/shared";
import { buildAnalyzeRequest } from "../lib/request";

/** Backend calls (BUILD_PLAN 6.2). Only the AnalyzeRequest fields are ever sent. */

export const ANALYZE_TIMEOUT_MS = 25_000;
export const LOOKUP_TIMEOUT_MS = 1_500;

type FetchFn = typeof fetch;

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

export async function postAnalyze(
  apiBase: string,
  req: AnalyzeRequest,
  { fetchImpl = globalThis.fetch as FetchFn, timeoutMs = ANALYZE_TIMEOUT_MS } = {},
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
  });
}

/** F-06 instant path: a report someone already produced for this domain, or undefined. */
export async function lookupReport(
  apiBase: string,
  domain: string,
  { fetchImpl = globalThis.fetch as FetchFn, timeoutMs = LOOKUP_TIMEOUT_MS } = {},
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
    });
  } catch {
    return undefined;
  }
}
