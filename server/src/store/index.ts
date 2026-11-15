import { createRequire } from "node:module";
import { logError } from "../log.js";
import { MemoryStore } from "./memory.js";
import { SqliteStore } from "./sqlite.js";
import type { Store, StoreOptions } from "./store.js";

export type { Store, CachedAnalysis, StoreOptions } from "./store.js";
export { analysisKey, changeKey, DEFAULT_TTL_MS, MAX_SNAPSHOTS, SNAPSHOTS_PER_URL } from "./store.js";
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
export function openStore(dbPath: string, mode: "auto" | "sqlite" | "memory" = "auto", opts: StoreOptions = {}): Store {
  if (mode !== "memory") {
    const DatabaseSync = loadDatabaseSync();
    if (DatabaseSync) {
      try {
        return new SqliteStore(DatabaseSync, dbPath, opts);
      } catch (e) {
        if (mode === "sqlite") throw e;
      }
    } else if (mode === "sqlite") {
      throw new Error("node:sqlite is not available in this Node version");
    }
  }
  if (dbPath === ":memory:") return new MemoryStore(undefined, opts);
  return new MemoryStore(dbPath.replace(/\.db$/, "") + ".json", opts);
}

/**
 * A view of a store whose reads and writes never throw (review item 5): a failing call
 * (locked DB, full disk, corrupt row) logs an error kind and behaves like a cache miss,
 * so a request still gets its report, just uncached.
 */
export function guardStore(store: Store): Store {
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    (...a: A): R | undefined => {
      try {
        return fn.apply(store, a);
      } catch (e) {
        const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "error";
        logError("store." + name, code);
        return undefined;
      }
    };
  return {
    kind: store.kind,
    getAnalysis: wrap("getAnalysis", store.getAnalysis),
    putAnalysis: wrap("putAnalysis", store.putAnalysis) as Store["putAnalysis"],
    getLatestReport: wrap("getLatestReport", store.getLatestReport),
    putLatestReport: wrap("putLatestReport", store.putLatestReport) as Store["putLatestReport"],
    getSnapshot: wrap("getSnapshot", store.getSnapshot),
    putSnapshot: wrap("putSnapshot", store.putSnapshot) as Store["putSnapshot"],
    getChange: wrap("getChange", store.getChange),
    putChange: wrap("putChange", store.putChange) as Store["putChange"],
    close: wrap("close", store.close) as Store["close"],
  };
}
