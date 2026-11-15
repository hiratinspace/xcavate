import { Router } from "express";
import type { LlmClient } from "../llm/client.js";

export function healthRouter(llm: LlmClient): Router {
  const r = Router();
  r.get("/healthz", (_req, res) => {
    res.json({ ok: true, llm: llm.provider });
  });
  return r;
}
