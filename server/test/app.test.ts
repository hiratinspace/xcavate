import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportSchema } from "@xcavate/shared";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { buildRequest, caseById } from "../scripts/fixtureRequests.js";
import { createApp } from "../src/app.js";
import { MockLlm } from "../src/llm/mock.js";
import { openStore } from "../src/store/index.js";
import { FakeLlm, memStore, policyText, request as analyzeReq } from "./helpers.js";

const app = (opts: { rate?: number; llm?: MockLlm | FakeLlm; store?: ReturnType<typeof memStore> } = {}) =>
  createApp({ store: opts.store ?? memStore(), llm: opts.llm ?? new MockLlm(), config: { rateLimitPerMin: opts.rate ?? 1000 } });

const VALID = analyzeReq(policyText("All sales are final and no refunds will be given for any reason."));

describe("GET /healthz", () => {
  it('returns {"ok":true,"llm":"mock"}', async () => {
    const res = await request(app()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, llm: "mock" });
  });
  it("is CORS-open", async () => {
    const res = await request(app()).get("/healthz").set("Origin", "chrome-extension://abc");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("POST /v1/analyze", () => {
  it("valid body -> 200 + schema-valid Report", async () => {
    const res = await request(app()).post("/v1/analyze").send(VALID);
    expect(res.status).toBe(200);
    expect(ReportSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.verdict).toBe("red");
  });

  it("StreamNest fixture -> red", async () => {
    const res = await request(app()).post("/v1/analyze").send(buildRequest(caseById("streamnest")));
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("red");
    expect(res.body.domain).toBe("streamnest.localhost:4000");
  });

  it.each([
    [{}, /pageUrl/],
    [{ ...VALID, pageUrl: "ftp://x.test/a" }, /pageUrl: must be an http\(s\) URL/],
    [{ ...VALID, pageUrl: "https://x.test/a?card=1" }, /query string/],
    [{ ...VALID, pageType: "cart" }, /pageType/],
    [{ ...VALID, extra: 1 }, /Unrecognized key/],
    [{ ...VALID, policies: [{ ...VALID.policies[0], kind: "weird" }] }, /policies\.0\.kind/],
  ])("invalid body -> 400 with a readable message (%#)", async (body, msg) => {
    const res = await request(app()).post("/v1/analyze").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid request: /);
    expect(res.body.error).toMatch(msg);
  });

  it("5 policies -> 400", async () => {
    const res = await request(app())
      .post("/v1/analyze")
      .send({ ...VALID, policies: Array(5).fill(VALID.policies[0]) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 4 policies/);
  });

  it("policy text over 200 000 chars -> 400", async () => {
    const res = await request(app())
      .post("/v1/analyze")
      .send({ ...VALID, policies: [{ ...VALID.policies[0], text: "a".repeat(200_001) }] });
    expect(res.status).toBe(400);
  });

  it("oversize body -> 413", async () => {
    const res = await request(app())
      .post("/v1/analyze")
      .set("content-type", "application/json")
      .send(JSON.stringify({ ...VALID, policies: Array(4).fill({ ...VALID.policies[0], text: "b".repeat(300_000) }) }));
    expect(res.status).toBe(413);
  });

  it("malformed JSON -> 400", async () => {
    const res = await request(app()).post("/v1/analyze").set("content-type", "application/json").send("{nope");
    expect(res.status).toBe(400);
  });

  it("31st request in a minute -> 429", async () => {
    const a = app({ rate: 30 });
    for (let i = 0; i < 30; i++) expect((await request(a).post("/v1/analyze").send(VALID)).status).toBe(200);
    const res = await request(a).post("/v1/analyze").send(VALID);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    // Health and report lookups are not rate limited.
    expect((await request(a).get("/healthz")).status).toBe(200);
  });

  it("second identical call -> cached:true, under 300 ms, no LLM call", async () => {
    const llm = new FakeLlm();
    const a = app({ llm });
    await request(a).post("/v1/analyze").send(VALID);
    const t0 = Date.now();
    const res = await request(a).post("/v1/analyze").send(VALID);
    expect(Date.now() - t0).toBeLessThan(300);
    expect(res.body.cached).toBe(true);
    expect(llm.calls).toBe(1);
  });
});

describe("GET /v1/report", () => {
  it("404 when nothing is stored, 400 without a domain", async () => {
    expect((await request(app()).get("/v1/report?domain=nobody.test")).status).toBe(404);
    expect((await request(app()).get("/v1/report")).status).toBe(400);
  });

  it("returns the latest report with cached:true, by domain or full URL", async () => {
    const a = app();
    await request(a).post("/v1/analyze").send(buildRequest(caseById("streamnest")));
    const res = await request(a).get("/v1/report?domain=streamnest.localhost:4000");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cached: true, verdict: "red", domain: "streamnest.localhost:4000" });
    const byUrl = await request(a).get("/v1/report").query({ domain: "http://streamnest.localhost:4000/checkout" });
    expect(byUrl.status).toBe(200);
  });
});

describe("persistence across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "xcavate-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(["sqlite", "memory"] as const)("%s store keeps the cache and reports", async (mode) => {
    const path = join(dir, mode + ".db");
    const s1 = openStore(path, mode);
    expect(s1.kind).toBe(mode);
    await request(createApp({ store: s1, llm: new MockLlm(), config: { rateLimitPerMin: 100 } })).post("/v1/analyze").send(VALID);
    s1.close();

    const s2 = openStore(path, mode);
    const llm = new FakeLlm();
    const a = createApp({ store: s2, llm, config: { rateLimitPerMin: 100 } });
    const res = await request(a).post("/v1/analyze").send(VALID);
    expect(res.body.cached).toBe(true);
    expect(llm.calls).toBe(0);
    expect((await request(a).get("/v1/report?domain=shop.example.com")).status).toBe(200);
    s2.close();
  });
});
