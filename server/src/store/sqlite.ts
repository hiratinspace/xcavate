import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { ChangeSummary, Report } from "@xcavate/shared";
import type { CachedAnalysis, Store } from "./store.js";

type DatabaseSyncCtor = typeof DatabaseSyncType;

/** SQLite store on Node's built-in node:sqlite (DatabaseSync). */
export class SqliteStore implements Store {
  readonly kind = "sqlite" as const;
  private db: DatabaseSyncType;

  constructor(DatabaseSync: DatabaseSyncCtor, path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS reports   (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS domains   (domain TEXT PRIMARY KEY, report TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (url TEXT NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (url, hash));
      CREATE TABLE IF NOT EXISTS changes   (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
  }

  private getJson<T>(sql: string, ...params: string[]): T | undefined {
    const row = this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const v = Object.values(row)[0];
    return typeof v === "string" ? (JSON.parse(v) as T) : undefined;
  }

  getAnalysis(key: string) {
    return this.getJson<CachedAnalysis>("SELECT value FROM reports WHERE key = ?", key);
  }
  putAnalysis(key: string, value: CachedAnalysis) {
    this.db
      .prepare("INSERT OR REPLACE INTO reports (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), Date.now());
  }
  getLatestReport(domain: string) {
    return this.getJson<Report>("SELECT report FROM domains WHERE domain = ?", domain);
  }
  putLatestReport(domain: string, report: Report) {
    this.db
      .prepare("INSERT OR REPLACE INTO domains (domain, report, updated_at) VALUES (?, ?, ?)")
      .run(domain, JSON.stringify(report), Date.now());
  }
  getSnapshot(url: string, hash: string) {
    const row = this.db.prepare("SELECT text FROM snapshots WHERE url = ? AND hash = ?").get(url, hash) as
      | { text: string }
      | undefined;
    return row?.text;
  }
  putSnapshot(url: string, hash: string, text: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO snapshots (url, hash, text, created_at) VALUES (?, ?, ?, ?)")
      .run(url, hash, text, Date.now());
  }
  getChange(key: string) {
    return this.getJson<ChangeSummary>("SELECT value FROM changes WHERE key = ?", key);
  }
  putChange(key: string, value: ChangeSummary) {
    this.db
      .prepare("INSERT OR REPLACE INTO changes (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), Date.now());
  }
  close() {
    this.db.close();
  }
}
