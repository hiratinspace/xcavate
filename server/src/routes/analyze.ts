import { AnalyzeRequestSchema } from "@xcavate/shared";
import { Router } from "express";
import type { ZodError } from "zod";
import { logError, logRequest } from "../log.js";
import { runAnalysis } from "../pipeline/run.js";
import type { PipelineDeps } from "../pipeline/run.js";

/** "policies.0.url: must be an http(s) URL; pageType: Invalid enum value ..." */
export function formatZodError(err: ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message)
    .join("; ");
}

export function analyzeRouter(deps: PipelineDeps): Router {
  const r = Router();
  r.post("/v1/analyze", async (req, res) => {
    const parsed = AnalyzeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request: " + formatZodError(parsed.error) });
      return;
    }
    try {
      const report = await runAnalysis(parsed.data, deps);
      logRequest("analyze", {
        domain: report.domain,
        ms: report.stats.ms,
        cached: report.cached,
        usedLlm: report.stats.usedLlm,
        flagCount: report.flags.length,
      });
      res.json(report);
    } catch (e) {
      logError("analyze", e instanceof Error ? e.name : "unknown");
      res.status(500).json({ error: "Analysis failed" });
    }
  });
  return r;
}
