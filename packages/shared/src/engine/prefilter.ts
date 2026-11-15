import { KEYWORDS, LIMITS, normalizeForMatch } from "../core.js";
import type { Paragraph } from "./split.js";

const ALL_KEYWORDS: string[] = [...new Set(Object.values(KEYWORDS).flat())];

/** Number of distinct money keywords in a paragraph (section 7.4 step 2). */
export function keywordScore(text: string): number {
  const t = normalizeForMatch(text);
  let n = 0;
  for (const k of ALL_KEYWORDS) if (t.includes(k)) n++;
  return n;
}

export interface PrefilterPolicy {
  paragraphs: Paragraph[];
}

export interface PrefilterResult {
  /** Kept paragraphs per policy, in document order. Empty = no hits, skip the LLM for that policy. */
  kept: Paragraph[][];
  totalChars: number;
}

/**
 * Keep paragraphs with a keyword hit plus one neighbour either side, at most
 * `maxChars` in total across all policies, best-scoring first, then restore document order.
 */
export function prefilter(policies: PrefilterPolicy[], maxChars: number = LIMITS.prefilterMaxChars): PrefilterResult {
  interface Cand {
    p: number;
    para: Paragraph;
    score: number;
    hit: boolean;
  }
  const cands: Cand[] = [];
  policies.forEach((pol, p) => {
    const scores = pol.paragraphs.map((para) => keywordScore(para.text));
    const keep = new Map<number, Cand>();
    scores.forEach((s, i) => {
      if (s === 0) return;
      for (const j of [i - 1, i, i + 1]) {
        if (j < 0 || j >= pol.paragraphs.length) continue;
        const hit = scores[j] > 0;
        const prev = keep.get(j);
        // Neighbours rank below every hit; they borrow a fraction of the hit's score.
        const score = hit ? scores[j] : s / 100;
        if (!prev || score > prev.score) keep.set(j, { p, para: pol.paragraphs[j], score, hit });
      }
    });
    cands.push(...keep.values());
  });

  cands.sort((a, b) => b.score - a.score || a.p - b.p || a.para.index - b.para.index);
  const chosen: Cand[] = [];
  let total = 0;
  for (const c of cands) {
    const len = c.para.text.length;
    if (total + len > maxChars) continue;
    chosen.push(c);
    total += len;
  }
  const kept: Paragraph[][] = policies.map(() => []);
  for (const c of chosen) kept[c.p].push(c.para);
  for (const k of kept) k.sort((a, b) => a.index - b.index);
  return { kept, totalChars: total };
}
