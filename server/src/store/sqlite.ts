import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { ChangeSummary, Report } from "@xcavate/shared";
import { DEFAULT_TTL_MS, MAX_ENTRIES, MAX_SNAPSHOTS, SNAPSHOTS_PER_URL, SNAPSHOT_MAX_AGE_MS } from "./store.js";
import type { CachedAnalysis, Store, StoreOptions } from "./store.js";

type DatabaseSyncCtor = typeof DatabaseSyncType;

/** How long a write waits for a lock held by another process (e.g. seed while the server runs). */
const BUSY_TIMEOUT_MS = 5_000;
/** Prune expired and over-cap rows every N writes. */
const PRUNE_EVERY = 100;

/** SQLite store on Node's built-in node:sqlite (DatabaseSync). */
export class SqliteStore implements Store {
  readonly kind = "sqlite" as const;
  private db: DatabaseSyncType;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private writes = 0;

  constructor(DatabaseSync: DatabaseSyncCtor, path: string, opts: StoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS reports   (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS domains   (domain TEXT PRIMARY KEY, report TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (url TEXT NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (url, hash));
      CREATE TABLE IF NOT EXISTS changes   (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    // Older DBs lack the snapshot sequence column.
    try {
      this.db.exec("ALTER TABLE snapshots ADD COLUMN seq INTEGER NOT NULL DEFAULT 0");
    } catch {
      // already present
    }
  }

  /** First column of one row, parsed as JSON; undefined when missing, expired or unparseable. */
  private getJson<T>(sql: string, param: string, ttl: boolean): T | undefined {
    const row = this.db.prepare(sql).get(param) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const [v, at] = Object.values(row);
    if (ttl && typeof at === "number" && this.now() - at >= this.ttlMs) return undefined;
    if (typeof v !== "string") return undefined;
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  }

  private wrote(): void {
    if (++this.writes % PRUNE_EVERY !== 0) return;
    const cutoff = this.now() - this.ttlMs;
    this.db.prepare("DELETE FROM reports WHERE updated_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM domains WHERE updated_at < ?").run(cutoff);
    for (const t of ["reports", "changes"]) {
      this.db
        .prepare(`DELETE FROM ${t} WHERE key IN (SELECT key FROM ${t} ORDER BY updated_at DESC LIMIT -1 OFFSET ?)`)
        .run(MAX_ENTRIES);
    }
  }

  getAnalysis(key: string) {
    return this.getJson<CachedAnalysis>("SELECT value, updated_at FROM reports WHERE key = ?", key, true);
  }
  putAnalysis(key: string, value: CachedAnalysis) {
    this.db
      .prepare("INSERT OR REPLACE INTO reports (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), this.now());
    this.wrote();
  }
  getLatestReport(domain: string) {
    return this.getJson<Report>("SELECT report, updated_at FROM domains WHERE domain = ?", domain, true);
  }
  putLatestReport(domain: string, report: Report) {
    this.db
      .prepare("INSERT OR REPLACE INTO domains (domain, report, updated_at) VALUES (?, ?, ?)")
      .run(domain, JSON.stringify(report), this.now());
    this.wrote();
  }
  getSnapshot(url: string, hash: string) {
    const row = this.db.prepare("SELECT text FROM snapshots WHERE url = ? AND hash = ?").get(url, hash) as
      | { text: string }
      | undefined;
    return row?.text;
  }
  putSnapshot(url: string, hash: string, text: string) {
    const seq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM snapshots").get() as { n: number }).n;
    const t = this.now();
    this.db
      .prepare(
        "INSERT INTO snapshots (url, hash, text, created_at, seq) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (url, hash) DO UPDATE SET seq = excluded.seq, created_at = excluded.created_at",
      )
      .run(url, hash, text, t, seq);
    // Versions of this URL not seen for 30 days go; then the per-URL safety cap and the global cap.
    this.db.prepare("DELETE FROM snapshots WHERE url = ? AND created_at < ?").run(url, t - SNAPSHOT_MAX_AGE_MS);
    this.db
      .prepare(
        "DELETE FROM snapshots WHERE url = ? AND hash NOT IN (SELECT hash FROM snapshots WHERE url = ? ORDER BY seq DESC LIMIT ?)",
      )
      .run(url, url, SNAPSHOTS_PER_URL);
    this.db
      .prepare("DELETE FROM snapshots WHERE rowid IN (SELECT rowid FROM snapshots ORDER BY seq DESC LIMIT -1 OFFSET ?)")
      .run(MAX_SNAPSHOTS);
  }
  getChange(key: string) {
    return this.getJson<ChangeSummary>("SELECT value, updated_at FROM changes WHERE key = ?", key, false);
  }
  putChange(key: string, value: ChangeSummary) {
    this.db
      .prepare("INSERT OR REPLACE INTO changes (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), this.now());
    this.wrote();
  }
  close() {
    this.db.close();
  }
}
