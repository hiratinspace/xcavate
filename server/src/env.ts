import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** The server package directory (server/), whatever the current working directory is. */
export const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Load server/.env (never overrides variables already set in the environment). */
export function loadEnv(): void {
  dotenv.config({ path: join(SERVER_ROOT, ".env"), quiet: true } as dotenv.DotenvConfigOptions);
}

/** Relative DB paths are relative to server/, so dev, seed and eval share one DB. */
export function resolveDbPath(p: string): string {
  return p === ":memory:" || isAbsolute(p) ? p : join(SERVER_ROOT, p);
}
