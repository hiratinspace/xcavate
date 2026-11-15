import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPORT_RED } from "@xcavate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { analysisKey, loadDatabaseSync, openStore } from "../src/store/index.js";
import type { Store } from "../src/store/index.js";

const dir = mkdtempSync(join(tmpdir(), "xcavate-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("store", () => {
  it("node:sqlite is available on this Node", () => {
    expect(loadDatabaseSync()).toBeDefined();
    expect(openStore(":memory:").kind).toBe("sqlite");
  });

  it("analysisKey sorts hashes", () => {
    expect(analysisKey(["b", "a", "c"])).toBe(analysisKey(["c", "b", "a"]));
  });

  const cases: [string, () => Store][] = [
    ["sqlite", () => openStore(join(dir, "s.db"), "sqlite")],
    ["memory+json", () => openStore(join(dir, "m.db"), "memory")],
    ["memory only", () => openStore(":memory:", "memory")],
  ];
  it.each(cases)("%s round-trips every table", (_n, make) => {
    const s = make();
    const a = { flags: SAMPLE_REPORT_RED.flags, policies: SAMPLE_REPORT_RED.policies, droppedUnverified: 1, usedLlm: true };
    s.putAnalysis("k", a);
    expect(s.getAnalysis("k")).toEqual(a);
    expect(s.getAnalysis("nope")).toBeUndefined();
    s.putLatestReport("d", SAMPLE_REPORT_RED);
    expect(s.getLatestReport("d")).toEqual(SAMPLE_REPORT_RED);
    s.putSnapshot("u", "h", "text");
    s.putSnapshot("u", "h", "text");
    expect(s.getSnapshot("u", "h")).toBe("text");
    expect(s.getSnapshot("u", "x")).toBeUndefined();
    s.putChange("c", { policyUrl: "u", bullets: ["b"], moneyRelevant: true });
    expect(s.getChange("c")?.bullets).toEqual(["b"]);
    s.close();
  });
});
