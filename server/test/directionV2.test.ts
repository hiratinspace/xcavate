import { ReportSchema } from "@xcavate/shared";
import type { Flag } from "@xcavate/shared";
import { describe, expect, it } from "vitest";
import { buildRequest, caseById } from "../scripts/fixtureRequests.js";
import { MockLlm } from "../src/llm/mock.js";
import { CA_ONLINE_CANCEL_NOTE, rightsNotes } from "@xcavate/shared/engine";
import { runAnalysis } from "../src/pipeline/run.js";
import { CONTEXT_TEXT, recalibrate, sortFlags } from "@xcavate/shared/engine";
import type { CalibrationContext } from "@xcavate/shared/engine";
import { FakeLlm, memStore, policyText, request as mkReq } from "./helpers.js";

const run = (text: string, extra = {}) => runAnalysis(mkReq(text, extra), { store: memStore(), llm: new MockLlm() });
const cat = (r: { flags: Flag[] }, c: string) => r.flags.find((f) => f.category === c);

const RENEW = "Your subscription renews automatically each month until you cancel.";
const RENEW_YEARLY = "Your annual plan will automatically renew every year until you cancel.";
const ONLINE = "You can cancel your subscription online at any time in your account settings.";
const PHONE_ONLY = "Cancellations must be made by telephone only and require 30 days' notice.";
const TRIAL = "At the end of your 7-day free trial you will be charged $9.99 per month automatically unless you cancel.";
const PRICE = "We may change the subscription price from time to time; we will email you before any change.";

describe("V-01 auto_renewal calibration", () => {
  it("plain monthly renewal with online cancel -> low with context, verdict green", async () => {
    const r = await run(policyText(RENEW, ONLINE));
    expect(cat(r, "auto_renewal")).toMatchObject({ severity: "low", context: CONTEXT_TEXT.renewalOnline });
    expect(r.verdict).toBe("green");
  });

  it("plain yearly renewal with online cancel -> low", async () => {
    expect(cat(await run(policyText(RENEW_YEARLY, ONLINE)), "auto_renewal")?.severity).toBe("low");
  });

  it("yearly renewal with no online cancel path -> medium", async () => {
    const r = await run(policyText(RENEW_YEARLY));
    expect(cat(r, "auto_renewal")?.severity).toBe("medium");
    expect(cat(r, "auto_renewal")?.context).toBeUndefined();
    expect(r.verdict).toBe("yellow");
  });

  it("renewal where the price can rise -> medium", async () => {
    expect(cat(await run(policyText(RENEW, ONLINE, PRICE)), "auto_renewal")?.severity).toBe("medium");
  });

  it("renewal with phone-only cancellation and 30 days' notice -> high, red", async () => {
    const r = await run(policyText(RENEW, PHONE_ONLY));
    expect(cat(r, "auto_renewal")?.severity).toBe("high");
    expect(r.verdict).toBe("red");
  });

  it("the model cannot raise a plain renewal back to high", async () => {
    const llm = new FakeLlm((input) => ({
      findings: [{ category: "auto_renewal", severity: "high", title: "Renews", summary: "It renews.", costImpact: null, paragraphIndex: input[0].paragraphs.find((p) => p.text.includes("renews"))!.id, quote: RENEW }],
      trial: null,
      cancellation: null,
    }));
    const r = await runAnalysis(mkReq(policyText(RENEW, ONLINE)), { store: memStore(), llm });
    expect(cat(r, "auto_renewal")?.severity).toBe("low");
  });
});

describe("V-01 trial_converts calibration", () => {
  it("normal monthly trial with online cancel -> medium with context", async () => {
    const r = await run(policyText(TRIAL, ONLINE));
    expect(cat(r, "trial_converts")).toMatchObject({ severity: "medium", context: CONTEXT_TEXT.trialNormal });
    expect(r.verdict).toBe("yellow");
  });

  it.each([
    ["to an annual plan", "At the end of your free trial you will be charged $99 for an annual plan automatically.", ONLINE],
    ["with no reminder", TRIAL + " We will not send you a reminder before the trial ends and you are charged.", ONLINE],
    ["with phone-only cancel", TRIAL, PHONE_ONLY],
  ])("auto-converting trial %s -> high", async (_n, a, b) => {
    const r = await run(policyText(a, b));
    expect(cat(r, "trial_converts")?.severity).toBe("high");
    expect(r.verdict).toBe("red");
  });

  it("StreamNest stays red: trial high, renewal high, phone-only", async () => {
    const r = await runAnalysis(buildRequest(caseById("streamnest")), { store: memStore(), llm: new MockLlm() });
    expect(r.verdict).toBe("red");
    expect(cat(r, "trial_converts")?.severity).toBe("high");
    expect(cat(r, "auto_renewal")?.severity).toBe("high");
  });

  it("recalibrate is pure and leaves other categories alone", () => {
    const f = (category: Flag["category"], severity: Flag["severity"], quote: string): Flag => ({
      id: category + ":0", category, severity, title: "t", summary: "s", quote, policyUrl: "u", paragraphIndex: 0, source: "rules",
    });
    const ctx: CalibrationContext = { onlineCancel: true, harshCancel: false, noReminder: false, priceCanRise: false };
    const out = recalibrate([f("no_refund", "high", "All sales are final."), f("auto_renewal", "high", RENEW)], ctx);
    expect(out[0].severity).toBe("high");
    expect(out[1].severity).toBe("low");
  });
});

describe("V-01 arbitration and data sharing", () => {
  it("never change the verdict and sort after money flags", async () => {
    const r = await run(
      policyText(
        "Any dispute will be resolved by binding individual arbitration in Delaware.",
        "We may sell your personal information to carefully chosen partners.",
        RENEW,
        ONLINE,
      ),
    );
    expect(r.verdict).toBe("green");
    expect(r.flags.map((f) => f.category)).toEqual(["auto_renewal", "data_sharing", "arbitration"]);
  });

  it("sortFlags puts a medium data_sharing after a low money flag", () => {
    const mk = (category: Flag["category"], severity: Flag["severity"]): Flag => ({
      id: category, category, severity, title: "t", summary: "s", quote: "q", policyUrl: "u", paragraphIndex: 0, source: "rules",
    });
    expect(sortFlags([mk("data_sharing", "medium"), mk("auto_renewal", "low")]).map((f) => f.category)).toEqual(["auto_renewal", "data_sharing"]);
  });
});

describe("V-02 partly read", () => {
  const privacyOnly = (text: string) => ({ policies: [{ url: "https://shop.example.com/privacy", kind: "privacy" as const, text }] });

  it("only a privacy page read and no money flags -> partial", async () => {
    const r = await run("", privacyOnly(policyText("We collect your email address to send receipts.")));
    expect(r.verdict).toBe("partial");
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  it("terms unreadable, privacy read -> partial", async () => {
    const r = await run("", {
      linksFound: 2,
      policies: [
        { url: "https://shop.example.com/terms", kind: "terms", text: "Loading..." },
        { url: "https://shop.example.com/privacy", kind: "privacy", text: policyText("We collect your email address.") },
      ],
    });
    expect(r.verdict).toBe("partial");
  });

  it("a manual scan (kind other) counts as terms-like -> green", async () => {
    const r = await run("", { pageType: "none", linksFound: 0, policies: [{ url: "https://shop.example.com/help", kind: "other", text: policyText("We love dogs. You can return any item within 60 days for a full refund.") }] });
    expect(r.verdict).toBe("green");
  });

  it("FairBox (refunds + terms + privacy) stays green", async () => {
    const r = await runAnalysis(buildRequest(caseById("fairbox")), { store: memStore(), llm: new MockLlm() });
    expect(r.verdict).toBe("green");
  });
});

describe("V-03 mock is not a model", () => {
  it("usedLlm=false and every flag is source rules", async () => {
    const r = await runAnalysis(buildRequest(caseById("streamnest")), { store: memStore(), llm: new MockLlm() });
    expect(r.stats.usedLlm).toBe(false);
    expect(new Set(r.flags.map((f) => f.source))).toEqual(new Set(["rules"]));
  });
});

describe("manual scans are not snapshotted", () => {
  it("kind other on pageType none is not stored; normal policies are", async () => {
    const store = memStore();
    const text = policyText(RENEW, ONLINE);
    const manual = await runAnalysis(
      mkReq("", { pageType: "none", linksFound: 0, policies: [{ url: "https://shop.example.com/account", kind: "other", text }] }),
      { store, llm: new MockLlm() },
    );
    expect(store.getSnapshot("https://shop.example.com/account", manual.policies[0].textHash)).toBeUndefined();
    const normal = await runAnalysis(mkReq(text), { store, llm: new MockLlm() });
    expect(store.getSnapshot("https://shop.example.com/terms", normal.policies[0].textHash)).toBeDefined();
  });

  it("policy URLs come back exactly as sent", async () => {
    const r = await run(policyText(RENEW), { policies: [{ url: "https://Shop.Example.com/Legal/Terms/", kind: "terms", text: policyText(RENEW) }] });
    expect(r.policies[0].url).toBe("https://Shop.Example.com/Legal/Terms/");
    expect(r.flags[0].policyUrl).toBe("https://Shop.Example.com/Legal/Terms/");
  });
});

describe("V-08 rights notes", () => {
  it("the note is neutral, cites the statute, says it is not advice, and fits the field", () => {
    expect(CA_ONLINE_CANCEL_NOTE).toMatch(/Cal\. Bus\. & Prof\. Code §17602\(d\)\(1\)/);
    expect(CA_ONLINE_CANCEL_NOTE).toMatch(/AB 2863/);
    expect(CA_ONLINE_CANCEL_NOTE).toMatch(/July 1, 2025/);
    expect(CA_ONLINE_CANCEL_NOTE).toMatch(/not legal advice/);
    expect(CA_ONLINE_CANCEL_NOTE).not.toMatch(/illegal|violat|scam|sue/i);
    expect(CA_ONLINE_CANCEL_NOTE.length).toBeLessThanOrEqual(400);
  });

  it("StreamNest (phone-only cancel on an online sign-up) gets the note on its cancellation flag", async () => {
    const r = await runAnalysis(buildRequest(caseById("streamnest")), { store: memStore(), llm: new MockLlm() });
    const cf = cat(r, "cancellation_friction")!;
    expect(cf.rightsNote).toBe(CA_ONLINE_CANCEL_NOTE);
    expect(r.flags.filter((f) => f.rightsNote)).toHaveLength(1);
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  const flag = (category: Flag["category"], quote: string): Flag => ({
    id: category + ":1", category, severity: "high", title: "t", summary: "s", quote, policyUrl: "u", paragraphIndex: 0, source: "rules",
  });

  it.each([
    ["no subscription", [flag("cancellation_friction", PHONE_ONLY)], undefined],
    ["online cancel also offered", [flag("auto_renewal", RENEW), flag("cancellation_friction", "Cancel online or by calling us on 1-800-555-0100 to cancel your plan.")], undefined],
    ["no cancellation flag", [flag("auto_renewal", RENEW)], undefined],
  ])("no note when %s", (_n, flags, cancellation) => {
    expect(rightsNotes({ flags, cancellation }, "https://shop.example.com/checkout")).toEqual([]);
  });

  it("no note for a non-web page URL; note for mail-only cancellation", () => {
    const flags = [flag("auto_renewal", RENEW), flag("cancellation_friction", "To cancel your membership you must send a written request by certified mail.")];
    expect(rightsNotes({ flags }, "file:///tmp/x.html")).toEqual([]);
    expect(rightsNotes({ flags }, "https://gym.example.com/join")).toEqual([{ flagId: "cancellation_friction:1", text: CA_ONLINE_CANCEL_NOTE }]);
  });

  it("uses the extracted cancellation method when the flag quote is about notice only", () => {
    const flags = [flag("trial_converts", TRIAL), flag("cancellation_friction", "Cancellation requires at least 30 days' notice before the next billing date.")];
    const notes = rightsNotes({ flags, cancellation: { method: "phone", steps: [], quote: "To cancel, call us on 1-800-555-0100." } }, "https://x.example/signup");
    expect(notes).toHaveLength(1);
  });
});

describe("rules helpers", () => {
  it("prepaid renewal with no online cancel path -> medium", async () => {
    const r = await run(policyText("Your membership is paid in advance and renews automatically until you cancel."));
    expect(cat(r, "auto_renewal")?.severity).toBe("medium");
  });

  it("no source file contains a stray control character (a lost regex \\b once broke three rules)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "..", "src");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    const bad = files.filter((f) => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(readFileSync(join(root, f), "utf8")));
    expect(bad).toEqual([]);
  });
});
