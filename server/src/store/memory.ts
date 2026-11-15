import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChangeSummary, Report } from "@xcavate/shared";
import type { CachedAnalysis, Store } from "./store.js";

interface Dump {
  analyses: Record<string, CachedAnalysis>;
  reports: Record<string, Report>;
  snapshots: Record<string, string>;
  changes: Record<string, ChangeSummary>;
}

/** In-memory store with optional JSON file persistence (fallback when node:sqlite is unavailable). */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private analyses = new Map<string, CachedAnalysis>();
  private reports = new Map<string, Report>();
  private snapshots = new Map<string, string>();
  private changes = new Map<string, ChangeSummary>();

  constructor(private readonly filePath?: string) {
    if (filePath && existsSync(filePath)) {
      try {
        const d = JSON.parse(readFileSync(filePath, "utf8")) as Partial<Dump>;
        this.analyses = new Map(Object.entries(d.analyses ?? {}));
        this.reports = new Map(Object.entries(d.reports ?? {}));
        this.snapshots = new Map(Object.entries(d.snapshots ?? {}));
        this.changes = new Map(Object.entries(d.changes ?? {}));
      } catch {
        // Corrupt file: start empty rather than crash.
      }
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const d: Dump = {
      analyses: Object.fromEntries(this.analyses),
      reports: Object.fromEntries(this.reports),
      snapshots: Object.fromEntries(this.snapshots),
      changes: Object.fromEntries(this.changes),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(d));
    renameSync(tmp, this.filePath);
  }

  getAnalysis(key: string) {
    return this.analyses.get(key);
  }
  putAnalysis(key: string, value: CachedAnalysis) {
    this.analyses.set(key, value);
    this.persist();
  }
  getLatestReport(domain: string) {
    return this.reports.get(domain);
  }
  putLatestReport(domain: string, report: Report) {
    this.reports.set(domain, report);
    this.persist();
  }
  getSnapshot(url: string, hash: string) {
    return this.snapshots.get(url + "|" + hash);
  }
  putSnapshot(url: string, hash: string, text: string) {
    const k = url + "|" + hash;
    if (this.snapshots.get(k) === text) return;
    this.snapshots.set(k, text);
    this.persist();
  }
  getChange(key: string) {
    return this.changes.get(key);
  }
  putChange(key: string, value: ChangeSummary) {
    this.changes.set(key, value);
    this.persist();
  }
  close() {}
}
