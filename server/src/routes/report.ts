import { domainOf } from "@xcavate/shared";
import { Router } from "express";
import { logRequest } from "../log.js";
import type { Store } from "../store/store.js";

/** Accept "example.com", "example.com:4000" or a full URL. */
export function normalizeDomainParam(raw: string): string | undefined {
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 300) return undefined;
  try {
    return domainOf(s.includes("://") ? s : "http://" + s);
  } catch {
    return undefined;
  }
}

export function reportRouter(store: Store): Router {
  const r = Router();
  r.get("/v1/report", (req, res) => {
    const t0 = performance.now();
    const raw = typeof req.query.domain === "string" ? req.query.domain : "";
    const domain = normalizeDomainParam(raw);
    if (!domain) {
      res.status(400).json({ error: "Invalid request: domain query parameter is required" });
      return;
    }
    const report = store.getLatestReport(domain);
    if (!report) {
      res.status(404).json({ error: "No report stored for this domain" });
      return;
    }
    const ms = performance.now() - t0;
    logRequest("report", { domain, ms, cached: true, usedLlm: report.stats.usedLlm, flagCount: report.flags.length });
    res.json({ ...report, cached: true });
  });
  return r;
}
