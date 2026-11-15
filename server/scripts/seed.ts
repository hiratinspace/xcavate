/**
 * npm run seed (F-06): analyse every fixture store into the DB so
 * GET /v1/report?domain=<store>.localhost:4000 answers instantly.
 * StreamNest v2 is analysed first (so its snapshot and report are cached for the
 * change-alert demo), then v1, so the stored latest report is the v1 one.
 */
import { domainOf } from "@xcavate/shared";
import { loadConfig } from "../src/config.js";
import { loadEnv, resolveDbPath } from "../src/env.js";
import { createLlm } from "../src/llm/index.js";
import { setSilent } from "../src/log.js";
import { runAnalysis } from "../src/pipeline/run.js";
import { openStore } from "../src/store/index.js";
import { FIXTURE_CASES, STREAMNEST_V2, buildRequest } from "./fixtureRequests.js";

setSilent(true);
loadEnv();
const config = loadConfig();
const dbPath = resolveDbPath(config.dbPath);
const store = openStore(dbPath, config.store);
const llm = createLlm(config);

// The quoted SneakyTerms variant shares the sneakyterms domain; leave the real store as the latest report.
const order = [STREAMNEST_V2, ...FIXTURE_CASES.filter((c) => c.id !== "sneakyterms_quoted")];
const rows: string[] = [];
for (const c of order) {
  const req = buildRequest(c);
  const report = await runAnalysis(req, { store, llm });
  rows.push(
    [c.id.padEnd(14), domainOf(req.pageUrl).padEnd(28), report.verdict.padEnd(7), (report.cached ? "cached" : "fresh").padEnd(7), report.flags.map((f) => f.category).join(",")].join(" "),
  );
}
store.close();
process.stdout.write(`Seeded ${order.length} reports into ${store.kind} store (${dbPath}), llm=${llm.provider}\n` + rows.join("\n") + "\n");
