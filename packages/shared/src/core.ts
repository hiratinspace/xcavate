/**
 * zod-free entry point ("@xcavate/shared/core") for code that runs in every web page (the content
 * script): types, constants, text helpers and verdict wording. Schemas (zod) stay in the main entry.
 */
export type * from "./types.js";
export * from "./limits.js";
export * from "./categories.js";
export * from "./keywords.js";
export * from "./messages.js";
export * from "./text.js";
export * from "./verdict.js";
export * from "./samples.js";
