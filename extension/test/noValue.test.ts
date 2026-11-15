import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D-01 / privacy guard: content-side code must never read what a user typed.
 * Fails if `.value` appears anywhere in code that runs in the page (content/ and lib/).
 * The only allowed mention is inside a comment line that says "never".
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|js)$/.test(f) ? [p] : [];
  });
}

describe("no .value reads in page-side code", () => {
  const root = join(__dirname, "..", "src");
  const targets = [...files(join(root, "content")), ...files(join(root, "lib"))];

  it("scans some files", () => {
    expect(targets.length).toBeGreaterThan(5);
  });

  for (const file of targets) {
    it(file.slice(root.length + 1), () => {
      const offending = readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\.value\b/.test(line))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*).*never/i.test(line));
      expect(offending).toEqual([]);
    });
  }
});
