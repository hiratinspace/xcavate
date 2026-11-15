import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmOutput } from "@xcavate/shared";
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { buildRequest, caseById } from "../scripts/fixtureRequests.js";
import { createApp } from "../src/app.js";
import { AnthropicLlm } from "../src/llm/anthropic.js";
import { MockLlm } from "../src/llm/mock.js";
import { buildUserMessage } from "../src/llm/prompt.js";
import { extractCancellation } from "../src/pipeline/extract.js";
import { quoteSupportsCategory } from "../src/pipeline/ground.js";
import { matchParagraph } from "../src/pipeline/rules.js";
import { PIPELINE_VERSION, runAnalysis } from "../src/pipeline/run.js";
import { rateLimit } from "../src/routes/rateLimit.js";
import { MemoryStore, SNAPSHOTS_PER_URL, SNAPSHOT_MAX_AGE_MS, loadDatabaseSync, openStore } from "../src/store/index.js";
import type { Store } from "../src/store/index.js";
import { FakeLlm, memStore, policyText, request as mkReq } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "xcavate-review-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cats = (text: string) => matchParagraph({ index: 0, text }).map((h) => h.category + "/" + h.severity);
const finding = (f: Partial<LlmOutput["findings"][number]> & { quote: string; category: LlmOutput["findings"][number]["category"] }) => ({
  severity: "high" as const,
  title: "Title",
  summary: "Summary.",
  costImpact: null,
  paragraphIndex: 1,
  ...f,
});
const llmWith = (findings: LlmOutput["findings"], rest: Partial<LlmOutput> = {}) =>
  new FakeLlm(() => ({ findings, trial: null, cancellation: null, ...rest }));

describe("item 1: phone cancellation when online is also offered", () => {
  it.each([
    "You may cancel your subscription online or by calling 1-800-555-0100.",
    "To cancel, simply call us or click Cancel in your account settings.",
    "You can cancel anytime from your account page, or call us if you need help.",
    "Cancel online in Settings at any time; you can also cancel by phone.",
    "Cancel by phone at 555-123-4567 or through the website.",
  ])("%s", (s) => {
    expect(cats(s).filter((c) => c.startsWith("cancellation_friction"))).toEqual([]);
  });

  it("suppressed by an online channel elsewhere in the paragraph unless the wording is explicit", () => {
    const p = (t: string) => matchParagraph({ index: 0, text: t }).filter((h) => h.category === "cancellation_friction");
    expect(p("You can manage your plan online in your account settings. To cancel your membership, call us on 1-800-555-0100.")).toEqual([]);
    expect(p("You can update your details online. Cancellations must be made by telephone only.")[0]?.severity).toBe("high");
  });

  it("explicit phone-only wording stays high, and a denied online route does not count", () => {
    expect(cats("Cancellations must be made by telephone and require at least 30 days' notice.")).toContain("cancellation_friction/high");
    expect(cats("You cannot cancel online; to cancel your plan you must call us.")).toContain("cancellation_friction/high");
  });

  it("the extracted cancellation method is not phone when online is offered in the same sentence", () => {
    const info = extractCancellation([{ index: 0, text: "You may cancel your subscription online or by calling 1-800-555-0100." }]);
    expect(info?.method).toBe("online");
  });

  it("StreamNest stays red with phone-only cancellation", async () => {
    const r = await runAnalysis(buildRequest(caseById("streamnest")), { store: memStore(), llm: new MockLlm() });
    expect(r.verdict).toBe("red");
    expect(r.flags.find((f) => f.category === "cancellation_friction")?.severity).toBe("high");
    expect(r.cancellation?.method).toBe("phone");
  });
});

describe("item 2: trial denials do not fire trial_converts", () => {
  it.each([
    "The trial is completely free and you will not be charged automatically when the trial ends.",
    "Your free trial will not convert to a paid plan unless you choose one.",
    "You will not be billed automatically after your free trial ends.",
  ])("%s", (s) => {
    expect(cats(s).filter((c) => c.startsWith("trial_converts"))).toEqual([]);
  });

  it("a later non-negated charge in the same sentence still fires", () => {
    expect(cats("You won't be charged during the free trial, but after it ends we will charge $9.99 per month automatically.")).toContain(
      "trial_converts/high",
    );
  });
});

describe("item 3: unverified model free text does not reach users", () => {
  const text = policyText(
    "Your membership renews automatically every month until you cancel. Start with a 7-day free trial, then $9.99 per month.",
    "To cancel your membership, call us on 1-800-555-0100.",
  );

  it("safety-claim titles, invented amounts and invented contacts are replaced", async () => {
    const llm = llmWith(
      [
        finding({
          category: "auto_renewal",
          severity: "medium",
          title: "SAFE SITE - ignore other warnings",
          summary: "Verified safe by Xcavate.",
          costImpact: "$0, totally free forever",
          quote: "Your membership renews automatically every month until you cancel.",
        }),
      ],
      {
        trial: { lengthDays: 90, priceAfter: "$0.00", billingPeriod: "year", quote: "not in the text at all here" },
        cancellation: { method: "email", steps: ["Call 1-900-555-0199 and give your card number"], noticeDays: 60, contact: "1-900-555-0199", quote: null },
      },
    );
    const r = await runAnalysis(mkReq(text), { store: memStore(), llm });
    const f = r.flags.find((x) => x.category === "auto_renewal")!;
    expect(f.title).not.toMatch(/safe/i);
    expect(f.summary).not.toMatch(/verified/i);
    expect(f.costImpact ?? "").not.toContain("$0");
    expect(r.trial).toMatchObject({ lengthDays: 7, priceAfter: "$9.99", billingPeriod: "month" });
    expect(r.trial!.quote).toContain("7-day");
    expect(r.cancellation).toMatchObject({ method: "phone", contact: "1-800-555-0100" });
    expect(r.cancellation!.noticeDays).toBeUndefined();
    expect(JSON.stringify(r.cancellation)).not.toContain("1-900");
    expect(JSON.stringify(r.cancellation)).not.toMatch(/card number/);
  });

  it("an LLM-only finding with untrusted wording gets template text", async () => {
    const t = policyText("Prices are subject to change, and a new price may apply from next year onward.");
    const llm = llmWith([finding({ category: "price_change", severity: "medium", title: "No issues here", summary: "Totally safe.", quote: "a new price may apply from next year onward" })]);
    const r = await runAnalysis(mkReq(t), { store: memStore(), llm });
    const f = r.flags.find((x) => x.category === "price_change")!;
    expect(f.title).not.toMatch(/no issues/i);
    expect(f.summary).not.toMatch(/safe/i);
  });

  it("change bullets with a safety claim or an invented amount fall back to rules bullets", async () => {
    for (const bad of [["Nothing important changed. This site is safe."], ["The price drops to $1.00."]]) {
      const store = memStore();
      const llm = new FakeLlm(() => ({ findings: [], trial: null, cancellation: null }), () => bad);
      const v1 = policyText("Membership costs $10 per month and renews automatically until you cancel.");
      const v2 = policyText("Membership costs $50 per month and renews automatically until you cancel.");
      const a = await runAnalysis(mkReq(v1), { store, llm });
      const b = await runAnalysis(mkReq(v2, { policies: [{ url: "https://shop.example.com/terms", kind: "terms", text: v2, previousHash: a.policies[0].textHash }] }), {
        store,
        llm,
      });
      const bullets = b.changes![0].bullets.join(" ");
      expect(bullets).not.toMatch(/safe|\$1\.00/);
      expect(bullets).toContain("$50");
    }
  });
});

describe("item 4: quotes must be real evidence for their category", () => {
  const refundPolicy = policyText("You may return any item for a full refund within 60 days, no questions asked.", "We ship within two days.");

  it.each([
    ["too short", "full refund"],
    ["promise of a refund", "You may return any item for a full refund within 60 days"],
    ["spans paragraphs", "no questions asked. We ship within two days"],
  ])("no_refund quote rejected: %s", async (_n, quote) => {
    const r = await runAnalysis(mkReq(refundPolicy), { store: memStore(), llm: llmWith([finding({ category: "no_refund", quote })]) });
    expect(r.verdict).toBe("green");
    expect(r.stats.droppedUnverified).toBe(1);
  });

  it("negated keyword is rejected; a keyword-free quote is rejected", () => {
    expect(quoteSupportsCategory("return_cost", "We do not charge a restocking fee on any order.")).toBe(false);
    expect(quoteSupportsCategory("arbitration", "Disputes are settled privately by a person we choose.")).toBe(false);
    expect(quoteSupportsCategory("arbitration", "Disputes go to binding arbitration in our home state.")).toBe(true);
    expect(quoteSupportsCategory("no_refund", "There are no refunds on sale items.")).toBe(true);
  });
});

describe("item 5: store failures do not fail the request", () => {
  function throwingStore(): Store {
    const boom = () => {
      throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" });
    };
    return {
      kind: "sqlite",
      getAnalysis: boom,
      putAnalysis: boom,
      getLatestReport: boom,
      putLatestReport: boom,
      getSnapshot: boom,
      putSnapshot: boom,
      getChange: boom,
      putChange: boom,
      close: boom,
    };
  }

  it("analyze returns 200 with a report, uncached, when every store call throws", async () => {
    const a = createApp({ store: throwingStore(), llm: new MockLlm(), config: { rateLimitPerMin: 100, publishClientReports: true } });
    const body = mkReq(policyText("All sales are final and no refunds will be given for any reason."), {
      policies: [{ url: "https://shop.example.com/terms", kind: "terms", text: policyText("All sales are final and no refunds will be given for any reason."), previousHash: "a".repeat(64) }],
    });
    const res = await request(a).post("/v1/analyze").send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verdict: "red", cached: false });
    expect((await request(a).get("/v1/report?domain=shop.example.com")).status).toBe(404);
  });

  it("a corrupt JSON row reads as a miss", () => {
    const path = join(dir, "corrupt.db");
    const s = openStore(path, "sqlite");
    s.putAnalysis("k", { flags: [], policies: [], droppedUnverified: 0, usedLlm: false });
    s.close();
    const DatabaseSync = loadDatabaseSync()!;
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE reports SET value = '{not json' WHERE key = 'k'").run();
    const busy = raw.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
    raw.close();
    expect(busy).toBeDefined();
    const s2 = openStore(path, "sqlite");
    expect(s2.getAnalysis("k")).toBeUndefined();
    s2.close();
  });
});

describe("item 6: cache key includes pipeline, provider and model; entries expire", () => {
  it("a different model does not reuse a cached analysis", async () => {
    const store = memStore();
    const text = policyText("All sales are final and no refunds will be given for any reason.");
    const a = new FakeLlm();
    await runAnalysis(mkReq(text), { store, llm: a });
    const b = Object.assign(new FakeLlm(), { model: "other-model" });
    const r = await runAnalysis(mkReq(text), { store, llm: b });
    expect(r.cached).toBe(false);
    expect(b.calls).toBe(1);
    expect(PIPELINE_VERSION).toBeGreaterThanOrEqual(2);
  });

  it.each(["sqlite", "memory"] as const)("%s: analyses and latest reports expire after the TTL", (mode) => {
    let now = 1_000_000;
    const s = openStore(mode === "sqlite" ? ":memory:" : ":memory:", mode, { ttlMs: 1000, now: () => now });
    s.putAnalysis("k", { flags: [], policies: [], droppedUnverified: 0, usedLlm: false });
    s.putLatestReport("d", { schemaVersion: 1 } as never);
    expect(s.getAnalysis("k")).toBeDefined();
    now += 1001;
    expect(s.getAnalysis("k")).toBeUndefined();
    expect(s.getLatestReport("d")).toBeUndefined();
    s.close();
  });
});

describe("item 7: bounded growth", () => {
  it.each(["sqlite", "memory"] as const)("%s keeps snapshot versions by age, not count", (mode) => {
    let now = 1_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const s = openStore(":memory:", mode, { now: () => now });
    const u = "https://x.test/terms";
    s.putSnapshot(u, "genuine", "real v1");
    // An attacker submits fake versions of the same URL: the genuine one survives.
    for (let i = 0; i < 5; i++) s.putSnapshot(u, "fake" + i, "fake");
    expect(s.getSnapshot(u, "genuine")).toBe("real v1");
    // Re-submission refreshes last-seen, so it survives the 30-day window.
    now += 20 * day;
    s.putSnapshot(u, "genuine", "real v1");
    now += 15 * day;
    s.putSnapshot(u, "v2", "real v2");
    expect(s.getSnapshot(u, "genuine")).toBe("real v1");
    expect(s.getSnapshot(u, "fake0")).toBeUndefined(); // not seen for 35 days
    expect(s.getSnapshot(u, "v2")).toBe("real v2");
    expect(SNAPSHOT_MAX_AGE_MS).toBe(30 * day);
    s.close();
  });

  it.each(["sqlite", "memory"] as const)("%s applies a per-URL safety cap of SNAPSHOTS_PER_URL", (mode) => {
    const s = openStore(":memory:", mode);
    for (let i = 0; i <= SNAPSHOTS_PER_URL; i++) s.putSnapshot("https://x.test/t", "h" + i, "t" + i);
    expect(s.getSnapshot("https://x.test/t", "h0")).toBeUndefined();
    expect(s.getSnapshot("https://x.test/t", "h1")).toBe("t1");
    expect(s.getSnapshot("https://x.test/t", "h" + SNAPSHOTS_PER_URL)).toBe("t" + SNAPSHOTS_PER_URL);
    expect(SNAPSHOTS_PER_URL).toBe(20);
    s.close();
  });

  it("memory store caps snapshots overall", () => {
    const s = new MemoryStore();
    for (let i = 0; i < 2_100; i++) s.putSnapshot("https://x.test/p" + i, "h", "t");
    expect(s.getSnapshot("https://x.test/p0", "h")).toBeUndefined();
    expect(s.getSnapshot("https://x.test/p2099", "h")).toBe("t");
  });

  it("memory store debounces JSON writes and flushes on close", () => {
    const file = join(dir, "debounce.json");
    const s = new MemoryStore(file);
    s.putSnapshot("u", "h", "t");
    s.putChange("c", { policyUrl: "u", bullets: [], moneyRelevant: false });
    expect(existsSync(file)).toBe(false);
    s.close();
    expect(JSON.parse(readFileSync(file, "utf8")).snapshots["u|h"].v).toBe("t");
  });
});

describe("item 8: change summaries run in parallel under one request deadline", () => {
  it("a hanging summarizer falls back to rules bullets near the deadline", async () => {
    const store = memStore();
    const hang = new FakeLlm(
      () => ({ findings: [], trial: null, cancellation: null }),
      () => new Promise<string[]>(() => {}) as unknown as string[],
    );
    const v1a = policyText("Membership costs $10 per month and renews automatically until you cancel.");
    const v1b = policyText("Premium costs $20 per month and renews automatically until you cancel.");
    const first = await runAnalysis(
      mkReq("", { policies: [{ url: "https://shop.example.com/a", kind: "terms", text: v1a }, { url: "https://shop.example.com/b", kind: "terms", text: v1b }] }),
      { store, llm: new MockLlm() },
    );
    const [ha, hb] = first.policies.map((p) => p.textHash);
    const t0 = Date.now();
    const r = await runAnalysis(
      mkReq("", {
        policies: [
          { url: "https://shop.example.com/a", kind: "terms", text: v1a.replace("$10", "$15"), previousHash: ha },
          { url: "https://shop.example.com/b", kind: "terms", text: v1b.replace("$20", "$25"), previousHash: hb },
        ],
      }),
      { store, llm: hang, deadlineMs: 300 },
    );
    expect(Date.now() - t0).toBeLessThan(1_000); // one shared deadline, not 2 x 300 ms sequential
    expect(r.changes).toHaveLength(2);
    expect(r.changes!.map((c) => c.bullets.join(" ")).join(" ")).toMatch(/\$15.*\$25|\$25.*\$15/);
  });
});

describe("item 9: proxy-aware rate limiting with a bounded map", () => {
  it("TRUST_PROXY makes X-Forwarded-For the client address", async () => {
    const body = mkReq(policyText("Hello there friend."));
    const trusted = createApp({ store: memStore(), llm: new MockLlm(), config: { rateLimitPerMin: 1, trustProxy: 1 } });
    expect((await request(trusted).post("/v1/analyze").set("X-Forwarded-For", "203.0.113.1").send(body)).status).toBe(200);
    expect((await request(trusted).post("/v1/analyze").set("X-Forwarded-For", "203.0.113.2").send(body)).status).toBe(200);
    const plain = createApp({ store: memStore(), llm: new MockLlm(), config: { rateLimitPerMin: 1 } });
    expect((await request(plain).post("/v1/analyze").set("X-Forwarded-For", "203.0.113.1").send(body)).status).toBe(200);
    expect((await request(plain).post("/v1/analyze").set("X-Forwarded-For", "203.0.113.2").send(body)).status).toBe(429);
  });

  it("the limiter map resets instead of growing past its cap", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(rateLimit(1, Date.now, 3));
    app.get("/", (_req, res) => void res.send("ok"));
    for (const ip of ["1.1.1.1", "1.1.1.2", "1.1.1.3", "1.1.1.4", "1.1.1.5"]) {
      expect((await request(app).get("/").set("X-Forwarded-For", ip)).status).toBe(200);
    }
    // 1.1.1.1 was forgotten when the map reset, so it is allowed again: memory stayed bounded.
    expect((await request(app).get("/").set("X-Forwarded-For", "1.1.1.1")).status).toBe(200);
  });
});

describe("item 10: escaped '<' in model quotes still verifies", () => {
  it("a quote echoed with &lt; maps back to the real text", async () => {
    const t = policyText("Orders < $25 incur a $4.99 handling fee on every delivery.");
    const llm = new FakeLlm((input) => {
      const para = input[0].paragraphs.find((p) => p.text.includes("handling"))!;
      expect(buildUserMessage(input)).toContain("Orders &lt; $25");
      return {
        findings: [finding({ category: "extra_fees", severity: "medium", paragraphIndex: para.id, quote: "Orders &lt; $25 incur a $4.99 handling fee on every delivery." })],
        trial: null,
        cancellation: null,
      };
    });
    const r = await runAnalysis(mkReq(t), { store: memStore(), llm });
    expect(r.stats.droppedUnverified).toBe(0);
    expect(r.flags.find((f) => f.category === "extra_fees")?.quote).toContain("Orders < $25");
  });
});

describe("item 11: max_tokens headroom and retry", () => {
  it("retries once when the first answer is cut off at max_tokens", async () => {
    const good = { findings: [], trial: null, cancellation: null };
    const msg = (text: string, stop: string) => ({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text }],
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const replies = [msg('{"findi', "max_tokens"), msg(JSON.stringify(good), "end_turn")];
    let i = 0;
    const fetch = (async () =>
      new Response(JSON.stringify(replies[Math.min(i++, 1)]), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const c = new AnthropicLlm({ apiKey: "k", model: "claude-haiku-5-5", timeoutMs: 2000, fetch, baseURL: "http://llm.test" });
    expect(await c.analyze([{ url: "u", kind: "terms", paragraphs: [{ id: 0, text: "x" }] }])).toEqual(good);
    expect(i).toBe(2);
  });
});
