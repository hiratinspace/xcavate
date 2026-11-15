import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { buildRequest, caseById } from "../scripts/fixtureRequests.js";
import { createApp } from "../src/app.js";
import { setSilent } from "../src/log.js";
import { failingLlm, memStore } from "./helpers.js";

const ROOT = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const OUTPUT_CALL = /\bconsole\.(log|info|warn|error|debug|trace|dir)\s*\(|process\.(stdout|stderr)\.write\s*\(/;
/** Identifiers that would carry request bodies, policy text, quotes or secrets. */
const SENSITIVE = /\b(req\.body|body|text|policies|policy|quote|paragraphs?|html|apiKey|llmApiKey|LLM_API_KEY|headers|message)\b/;

describe("A-09 log hygiene (grep)", () => {
  const sources = [...files(join(ROOT, "src")), ...files(join(ROOT, "scripts"))];

  it("only src/log.ts (and the seed summary) write output", () => {
    const offenders = sources
      .filter((f) => !f.endsWith(join("src", "log.ts")) && !f.endsWith(join("scripts", "seed.ts")))
      .filter((f) => OUTPUT_CALL.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("no output statement mentions bodies, policy text, quotes or keys", () => {
    for (const f of sources) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!OUTPUT_CALL.test(line)) return;
        // Look at the statement (this line and a few continuation lines).
        const stmt = lines.slice(i, i + 4).join(" ").split(/;\s*$/m)[0];
        expect(SENSITIVE.test(stmt), `${relative(ROOT, f)}:${i + 1}: ${line.trim()}`).toBe(false);
      });
    }
  });

  it("logRequest only takes the allowed fields", () => {
    const src = readFileSync(join(ROOT, "src", "log.ts"), "utf8");
    const iface = src.match(/interface RequestLogFields \{([^}]*)\}/)![1];
    const fields = [...iface.matchAll(/(\w+):/g)].map((m) => m[1]).sort();
    expect(fields).toEqual(["cached", "domain", "flagCount", "ms", "usedLlm"]);
  });
});

describe("A-09 log hygiene (runtime)", () => {
  it("an analyze request with an LLM failure logs no policy text", async () => {
    setSilent(false);
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const cons = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    try {
      const body = buildRequest(caseById("sneakyterms"));
      await request(createApp({ store: memStore(), llm: failingLlm(), config: { rateLimitPerMin: 100 } })).post("/v1/analyze").send(body);
    } finally {
      spy.mockRestore();
      cons.mockRestore();
      setSilent(true);
    }
    const all = out.join("\n");
    expect(all).toMatch(/"route":"analyze"/);
    expect(all).toMatch(/"domain":"sneakyterms.localhost:4000"/);
    expect(all).not.toMatch(/All sales are final/i);
    expect(all).not.toMatch(/termination/i);
    for (const line of out.filter((l) => l.includes('"route"'))) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(["cached", "domain", "flagCount", "ms", "route", "t", "usedLlm"]);
    }
  });
});
