import { defineConfig } from "@playwright/test";

/**
 * V-04: real-browser end-to-end pass. The specs load extension/dist into Playwright's bundled
 * Chromium and drive it over the fixture stores. Servers and the browser are started by the
 * worker fixture in support/harness.ts (not by `webServer`) because one spec stops the backend.
 *
 * Run with `npm run e2e` from the repo root (builds the extension first).
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  // One browser profile, one set of servers on fixed ports: no parallelism.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  outputDir: "../test-results/e2e",
  use: { trace: "retain-on-failure" },
});
