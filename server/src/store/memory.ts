import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChangeSummary, Report } from "@xcavate/shared";
import { DEFAULT_TTL_MS, MAX_ENTRIES, MAX_SNAPSHOTS, SNAPSHOTS_PER_URL, SNAPSHOT_MAX_AGE_MS } from "./store.js";
import type { CachedAnalysis, Store, StoreOptions } from "./store.js";

interface Entry<T> {
  v: T;
  at: number;
}

interface Dump {
  analyses: Record<string, Entry<CachedAnalysis>>;
  reports: Record<string, Entry<Report>>;
  snapshots: Record<string, Entry<string>>;
  changes: Record<string, Entry<ChangeSummary>>;
}

const PERSIST_DEBOUNCE_MS = 500;
const openStores = new Set<MemoryStore>();
let exitHookInstalled = false;

function isEntry(x: unknown): x is Entry<unknown> {
  return typeof x === "object" && x !== null && "at" in x && "v" in x;
}

/** Load a table from a dump; old dumps stored bare values, which are kept with at = now. */
function loadTable<T>(raw: Record<string, unknown> | undefined, now: number): Map<string, Entry<T>> {
  const m = new Map<string, Entry<T>>();
  for (const [k, v] of Object.entries(raw ?? {})) m.set(k, isEntry(v) ? (v as Entry<T>) : { v: v as T, at: now });
  return m;
}

/** Re-insert so Map order is "least recently written first", then evict past the cap. */
function setCapped<T>(m: Map<string, Entry<T>>, k: string, e: Entry<T>, cap: number): void {
  m.delete(k);
  m.set(k, e);
  while (m.size > cap) m.delete(m.keys().next().value as string);
}

/**
 * In-memory store with optional JSON file persistence (fallback when node:sqlite is unavailable).
 * Writes are debounced (500 ms) and flushed on close() and on process exit.
 */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private analyses = new Map<string, Entry<CachedAnalysis>>();
  private reports = new Map<string, Entry<Report>>();
  private snapshots = new Map<string, Entry<string>>();
  private changes = new Map<string, Entry<ChangeSummary>>();
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly filePath?: string,
    opts: StoreOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    if (filePath && existsSync(filePath)) {
      try {
        const d = JSON.parse(readFileSync(filePath, "utf8")) as Partial<Record<keyof Dump, Record<string, unknown>>>;
        const t = this.now();
        this.analyses = loadTable(d.analyses, t);
        this.reports = loadTable(d.reports, t);
        this.snapshots = loadTable(d.snapshots, t);
        this.changes = loadTable(d.changes, t);
      } catch {
        // Corrupt file: start empty rather than crash.
      }
    }
    if (filePath) {
      openStores.add(this);
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.on("exit", () => {
          for (const s of openStores) s.flush();
        });
      }
    }
  }

  private schedule(): void {
    if (!this.filePath) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, PERSIST_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Write pending changes to the JSON file now. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.filePath || !this.dirty) return;
    this.dirty = false;
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

  private fresh<T>(e: Entry<T> | undefined): T | undefined {
    return e && this.now() - e.at < this.ttlMs ? e.v : undefined;
  }

  getAnalysis(key: string) {
    return this.fresh(this.analyses.get(key));
  }
  putAnalysis(key: string, value: CachedAnalysis) {
    setCapped(this.analyses, key, { v: value, at: this.now() }, MAX_ENTRIES);
    this.schedule();
  }
  getLatestReport(domain: string) {
    return this.fresh(this.reports.get(domain));
  }
  putLatestReport(domain: string, report: Report) {
    setCapped(this.reports, domain, { v: report, at: this.now() }, MAX_ENTRIES);
    this.schedule();
  }
  getSnapshot(url: string, hash: string) {
    return this.snapshots.get(url + "|" + hash)?.v;
  }
  putSnapshot(url: string, hash: string, text: string) {
    const k = url + "|" + hash;
    const t = this.now();
    // Versions of this URL not seen for 30 days go first.
    for (const [x, e] of [...this.snapshots.entries()]) {
      if (x.startsWith(url + "|") && t - e.at >= SNAPSHOT_MAX_AGE_MS) this.snapshots.delete(x);
    }
    // At the per-URL cap, refuse NEW versions instead of evicting old ones (flooding must not push a
    // genuine older version out). Known versions are still refreshed.
    const count = [...this.snapshots.keys()].filter((x) => x.startsWith(url + "|")).length;
    if (!this.snapshots.has(k) && count >= SNAPSHOTS_PER_URL) return;
    // Re-submission refreshes last-seen (and moves the entry to the recent end of the Map).
    setCapped(this.snapshots, k, { v: text, at: t }, MAX_SNAPSHOTS);
    this.schedule();
  }
  getChange(key: string) {
    return this.changes.get(key)?.v;
  }
  putChange(key: string, value: ChangeSummary) {
    setCapped(this.changes, key, { v: value, at: this.now() }, MAX_ENTRIES);
    this.schedule();
  }
  close() {
    this.flush();
    openStores.delete(this);
  }
}
