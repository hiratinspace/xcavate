/**
 * Length-preserving normalisation for regex matching: lower-case and straighten
 * curly quotes and dashes one character for one, so match offsets map back to the
 * original string (normalizeForMatch can change length, e.g. an ellipsis becomes "...").
 */
export function lpNormalize(s: string): string {
  const out = s
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[ ​]/g, " ")
    .toLowerCase();
  if (out.length === s.length) return out;
  const lower = s.toLowerCase();
  return lower.length === s.length ? lower : s;
}

/** Split a paragraph into sentences, keeping the original text of each. */
export function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?]["')\]]?)\s+(?=["'(\[“]?[A-Z0-9$€£])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MONEY_RE = /(?:[$€£]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:usd|dollars|eur|euros)\b)/gi;

/** Money amounts as written, e.g. ["$14.99", "$19.99"]. */
export function findMoney(s: string): string[] {
  return (s.match(MONEY_RE) ?? []).map((m) => m.replace(/\s+/g, " ").trim());
}

export function findPercent(s: string): string | undefined {
  const m = s.match(/\b\d{1,3}(?:\.\d+)?\s?(?:%|percent\b)/i);
  return m ? m[0].replace(/\s?percent/i, "%") : undefined;
}

export type Period = "week" | "month" | "year";

export function findPeriod(s: string): Period | undefined {
  const t = s.toLowerCase();
  if (/\b(per|a|each|every)\s(month)\b|\/\s?(month|mo)\b|\bmonthly\b/.test(t)) return "month";
  if (/\b(per|a|each|every)\s(year|annum)\b|\/\s?(year|yr)\b|\b(annual(ly)?|yearly)\b/.test(t)) return "year";
  if (/\b(per|a|each|every)\s(week)\b|\/\s?(week|wk)\b|\bweekly\b/.test(t)) return "week";
  return undefined;
}

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
};

/** "7" or "seven" gives 7. */
export function toNumber(s: string): number | undefined {
  const n = Number.parseInt(s, 10);
  if (Number.isFinite(n)) return n;
  return WORD_NUM[s.toLowerCase()];
}

export const NUM =
  "(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty|sixty|ninety)";

/** Trim to at most `max` chars on a word boundary, keeping a substring of the input. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

/** Keep at most `n` words. */
export function clipWords(s: string, n: number): string {
  const w = s.trim().split(/\s+/);
  return w.length <= n ? s.trim() : w.slice(0, n).join(" ").replace(/[,;:]$/, "") + "...";
}

/** A window of `s` around [start, end), at most `max` chars, snapped to word boundaries. */
export function windowAround(s: string, start: number, end: number, max: number): string {
  if (s.length <= max) return s;
  const pad = Math.max(0, Math.floor((max - (end - start)) / 2));
  let a = Math.max(0, start - pad);
  let b = Math.min(s.length, a + max);
  a = Math.max(0, b - max);
  if (a > 0) {
    const sp = s.indexOf(" ", a);
    if (sp !== -1 && sp < start) a = sp + 1;
  }
  if (b < s.length) {
    const sp = s.lastIndexOf(" ", b);
    if (sp > end) b = sp;
  }
  return s.slice(a, b).trim();
}

/** Number of whitespace-separated words. */
export function wordsIn(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
