import { normalizeForMatch } from "@xcavate/shared";
import type { Paragraph } from "./split.js";

/**
 * Quote verification (A-05, section 7.4 step 5): a quote survives only if, after
 * normalising both sides, it is a substring of the policy text.
 */
export function verifyQuote(quote: string, policyText: string): boolean {
  const q = normalizeForMatch(quote);
  if (q.length < 8) return false;
  return normalizeForMatch(policyText).includes(q);
}

/** A policy prepared for repeated quote lookups. */
export interface VerifiablePolicy {
  normText: string;
  paragraphs: { index: number; norm: string }[];
}

export function prepareForVerify(text: string, paragraphs: Paragraph[]): VerifiablePolicy {
  return {
    normText: normalizeForMatch(text),
    paragraphs: paragraphs.map((p) => ({ index: p.index, norm: normalizeForMatch(p.text) })),
  };
}

/**
 * Find where a quote lives: first in the policy the model pointed at, then in the others.
 * Returns the policy position and the paragraph that contains it, or null if it is not in any policy.
 */
export function locateQuote(
  quote: string,
  policies: VerifiablePolicy[],
  preferred: number,
  hintParagraph = -1,
): { policy: number; paragraphIndex: number } | null {
  const q = normalizeForMatch(quote);
  if (q.length < 8) return null;
  const order = [preferred, ...policies.map((_, i) => i).filter((i) => i !== preferred)].filter(
    (i) => i >= 0 && i < policies.length,
  );
  for (const i of order) {
    const pol = policies[i];
    if (!pol.normText.includes(q)) continue;
    const hinted = pol.paragraphs.find((p) => p.index === hintParagraph);
    if (hinted && hinted.norm.includes(q)) return { policy: i, paragraphIndex: hinted.index };
    const whole = pol.paragraphs.find((p) => p.norm.includes(q));
    if (whole) return { policy: i, paragraphIndex: whole.index };
    // Spans paragraphs: report the one holding its start.
    const head = q.slice(0, 40);
    const start = pol.paragraphs.find((p) => p.norm.includes(head));
    return { policy: i, paragraphIndex: start ? start.index : hintParagraph };
  }
  return null;
}
