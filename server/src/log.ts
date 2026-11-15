/**
 * The only module allowed to write logs (A-09). It accepts a fixed set of
 * non-sensitive fields: never request bodies, policy text, quotes or keys.
 * A grep test (test/logHygiene.test.ts) enforces that no other file logs.
 */

export interface RequestLogFields {
  domain: string;
  ms: number;
  cached: boolean;
  usedLlm: boolean;
  flagCount: number;
}

let silent = process.env.XCAVATE_SILENT === "1" || process.env.VITEST === "true";

export function setSilent(v: boolean): void {
  silent = v;
}

function write(line: Record<string, string | number | boolean>): void {
  if (silent) return;
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...line }) + "\n");
}

/** One line per analyze/report request. */
export function logRequest(route: "analyze" | "report", f: RequestLogFields): void {
  write({ route, domain: f.domain, ms: Math.round(f.ms), cached: f.cached, usedLlm: f.usedLlm, flagCount: f.flagCount });
}

/** An error, described only by a short machine-readable kind (never a message that could echo input). */
export function logError(where: string, kind: string): void {
  write({ level: "error", where, kind });
}

/** Startup line. */
export function logStartup(port: number, llm: string, store: string): void {
  write({ msg: "listening", port, llm, store });
}
