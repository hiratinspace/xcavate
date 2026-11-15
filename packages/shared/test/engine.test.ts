import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReportSchema } from "../src/index.js";
import type { AnalyzeRequest } from "../src/index.js";
import { runRulesOnly } from "../src/engine/index.js";

const FILLER =
  "Our team works hard to bring you a great selection and friendly service. We were founded by people who love good design and fair dealing. ".repeat(4);
const text = (...p: string[]) => ["About us. " + FILLER, ...p].join("\n\n");

function req(t: string, extra: Partial<AnalyzeRequest> = {}): AnalyzeRequest {
  return {
    pageUrl: "https://shop.example.com/",
    pageType: "signup",
    linksFound: 1,
    policies: [{ url: "https://shop.example.com/terms", kind: "terms", text: t }],
    ...extra,
  };
}

describe("engine: runRulesOnly (V-06)", () => {
  it("returns a schema-valid report with usedLlm false", async () => {
    const r = await runRulesOnly(req(text("Start with a 7-day free trial, then $14.99 per month. You will be charged automatically unless you cancel before the trial ends.")));
    expect(ReportSchema.safeParse(r).success).toBe(true);
    expect(r.stats.usedLlm).toBe(false);
    expect(r.stats.droppedUnverified).toBe(0);
    expect(r.cached).toBe(false);
    expect(r.trial?.lengthDays).toBe(7);
    expect(r.flags.every((f) => f.source === "rules")).toBe(true);
  });

  it("plain renewal with online cancel is low, not red (V-01 recalibration)", async () => {
    const r = await runRulesOnly(req(text("Your subscription renews automatically each month until you cancel. You can cancel online at any time in your account settings.")));
    const renewal = r.flags.find((f) => f.category === "auto_renewal");
    expect(renewal?.severity).toBe("low");
    expect(r.verdict).not.toBe("red");
  });

  it("harsh cancellation is red", async () => {
    const r = await runRulesOnly(req(text("Your membership renews automatically every month until you cancel. Cancellation requests must be made by telephone with at least 30 days' notice.")));
    expect(r.verdict).toBe("red");
  });

  it("clean terms are green, privacy only is partial, nothing readable is unknown, no links on checkout is missing_policy", async () => {
    expect((await runRulesOnly(req(text("We offer a 30-day full refund on every order, and returns are free.")))).verdict).toBe("green");
    const privacy = text("We keep your data safe.");
    expect((await runRulesOnly(req(privacy, { policies: [{ url: "https://shop.example.com/privacy", kind: "privacy", text: privacy }] }))).verdict).toBe("partial");
    expect((await runRulesOnly(req("short"))).verdict).toBe("unknown");
    const none = await runRulesOnly(req("", { pageType: "checkout", linksFound: 0, policies: [] }));
    expect(none.flags.map((f) => f.category)).toEqual(["missing_policy"]);
    expect(none.verdict).toBe("yellow");
  });

  it("is deterministic apart from timing", async () => {
    const t = text("All sales are final. An early termination fee of $75.00 applies.");
    const at = () => new Date("2026-11-14T00:00:00Z");
    const a = await runRulesOnly(req(t), { now: at });
    const b = await runRulesOnly(req(t), { now: at });
    expect({ ...a, stats: { ...a.stats, ms: 0 } }).toEqual({ ...b, stats: { ...b.stats, ms: 0 } });
  });

  it("engine sources import neither zod, the zod barrel, nor Node modules", () => {
    const dir = join(__dirname, "../src/engine");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/from "zod"|from "@xcavate\/shared"|from "\.\.\/(index|schemas)\.js"|from "node:/);
    }
  });
});
