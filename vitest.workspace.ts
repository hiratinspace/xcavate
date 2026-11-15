export default [
  { test: { name: "shared", root: "./packages/shared", environment: "node", include: ["test/**/*.test.ts"] } },
  { test: { name: "server", root: "./server", environment: "node", include: ["test/**/*.test.ts"] } },
  { test: { name: "extension", root: "./extension", environment: "jsdom", include: ["test/**/*.test.ts"] } },
  { test: { name: "fixtures", root: "./fixtures", environment: "node", include: ["test/**/*.test.ts"] } },
];
