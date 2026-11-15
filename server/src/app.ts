import { LIMITS } from "@xcavate/shared";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";
import type { LlmClient } from "./llm/client.js";
import { analyzeRouter } from "./routes/analyze.js";
import { healthRouter } from "./routes/health.js";
import { rateLimit } from "./routes/rateLimit.js";
import { reportRouter } from "./routes/report.js";
import { guardStore } from "./store/index.js";
import type { Store } from "./store/store.js";

export interface AppDeps {
  store: Store;
  llm: LlmClient;
  config: Pick<Config, "rateLimitPerMin"> & Partial<Pick<Config, "publishClientReports" | "llmTimeoutMs" | "trustProxy">>;
}

/** Express app factory (S-04). Used by src/index.ts and by tests with supertest. */
export function createApp({ store, llm, config }: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy, TRUST_PROXY=<hops> makes req.ip the client address for rate limiting.
  if (config.trustProxy && config.trustProxy > 0) app.set("trust proxy", config.trustProxy);
  app.use(cors());
  app.use(healthRouter(llm));
  app.use("/v1/analyze", rateLimit(config.rateLimitPerMin));
  app.use(express.json({ limit: LIMITS.maxBodyBytes }));
  app.use(
    analyzeRouter({ store, llm, publishShared: config.publishClientReports === true, deadlineMs: config.llmTimeoutMs }),
  );
  app.use(reportRouter(guardStore(store)));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });
  // Body-parser errors: 413 too large, 400 malformed JSON. Never echo the body.
  app.use((err: { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.too.large" || err.status === 413) {
      res.status(413).json({ error: `Request body too large (limit ${LIMITS.maxBodyBytes} bytes)` });
    } else if (err.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid request: body is not valid JSON" });
    } else if (err.status && err.status >= 400 && err.status < 500) {
      res.status(err.status).json({ error: "Invalid request" });
    } else {
      res.status(500).json({ error: "Internal error" });
    }
  });
  return app;
}
