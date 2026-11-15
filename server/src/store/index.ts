import { createRequire } from "node:module";
import { MemoryStore } from "./memory.js";
import { SqliteStore } from "./sqlite.js";
import type { Store } from "./store.js";

export type { Store, CachedAnalysis } from "./store.js";
export { analysisKey, changeKey } from "./store.js";
export { MemoryStore } from "./memory.js";
export { SqliteStore } from "./sqlite.js";

/** node:sqlite's DatabaseSync, or undefined when this Node build lacks it. */
export function loadDatabaseSync(): typeof import("node:sqlite").DatabaseSync | undefined {
  try {
    const require = createRequire(import.meta.url);
    // Silence the one-time ExperimentalWarning some Node versions emit for node:sqlite.
    const emit = process.emitWarning;
    process.emitWarning = (() => {}) as typeof process.emitWarning;
    try {
      return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
    } finally {
      process.emitWarning = emit;
    }
  } catch {
    return undefined;
  }
}

/**
 * SQLite when available (or forced with mode "sqlite"), else memory + JSON file next to dbPath.
 * dbPath ":memory:" gives a throwaway store.
 */
export function openStore(dbPath: string, mode: "auto" | "sqlite" | "memory" = "auto"): Store {
  if (mode !== "memory") {
    const DatabaseSync = loadDatabaseSync();
    if (DatabaseSync) {
      try {
        return new SqliteStore(DatabaseSync, dbPath);
      } catch (e) {
        if (mode === "sqlite") throw e;
      }
    } else if (mode === "sqlite") {
      throw new Error("node:sqlite is not available in this Node version");
    }
  }
  if (dbPath === ":memory:") return new MemoryStore();
  return new MemoryStore(dbPath.replace(/\.db$/, "") + ".json");
}
