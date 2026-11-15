import { CATEGORY_LABEL, normalizeForMatch } from "@xcavate/shared";
import { keywordScore } from "./prefilter.js";
import { runRules } from "./rules.js";
import { splitParagraphs } from "./split.js";
import { findMoney } from "./textutil.js";

/** Paragraph-level diff (A-11): paragraphs only in the new text, and only in the old. */
export function diffParagraphs(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const oldP = splitParagraphs(oldText).map((p) => p.text);
  const newP = splitParagraphs(newText).map((p) => p.text);
  const oldSet = new Set(oldP.map(normalizeForMatch));
  const newSet = new Set(newP.map(normalizeForMatch));
  return {
    added: newP.filter((p) => !oldSet.has(normalizeForMatch(p))),
    removed: oldP.filter((p) => !newSet.has(normalizeForMatch(p))),
  };
}

/** True when any changed paragraph passes the money prefilter. */
export function isMoneyRelevant(added: string[], removed: string[]): boolean {
  return [...added, ...removed].some((p) => keywordScore(p) > 0);
}

function words(s: string): Set<string> {
  return new Set(normalizeForMatch(s).replace(/[^a-z0-9$.%' ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
}

function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.max(1, A.size + B.size - inter);
}

function amountValue(m: string): number {
  return Number.parseFloat(m.replace(/[^0-9.]/g, ""));
}

/**
 * Rules-based change bullets, used when the LLM is mock or offline. Mentions changed
 * prices and newly added money clauses (fees, renewals, refunds) first.
 */
export function ruleChangeBullets(added: string[], removed: string[]): string[] {
  const bullets: string[] = [];
  const push = (b: string) => {
    if (!bullets.includes(b)) bullets.push(b);
  };

  // Pair each removed paragraph with its most similar added paragraph (a "modified" paragraph).
  const pairedAdded = new Set<number>();
  const pairs: [string, string][] = [];
  const unpairedRemoved: string[] = [];
  for (const r of removed) {
    let best = -1;
    let bestSim = 0;
    added.forEach((a, i) => {
      if (pairedAdded.has(i)) return;
      const s = similarity(r, a);
      if (s > bestSim) [best, bestSim] = [i, s];
    });
    if (best >= 0 && bestSim >= 0.45) {
      pairedAdded.add(best);
      pairs.push([r, added[best]]);
    } else unpairedRemoved.push(r);
  }
  const newOnly = added.filter((_, i) => !pairedAdded.has(i));

  // 1. Changed amounts in modified paragraphs.
  for (const [oldP, newP] of pairs) {
    const before = findMoney(oldP);
    const after = findMoney(newP);
    const gone = before.filter((m) => !after.includes(m));
    const came = after.filter((m) => !before.includes(m));
    if (gone[0] && came[0]) {
      const dir = amountValue(came[0]) > amountValue(gone[0]) ? "goes up" : amountValue(came[0]) < amountValue(gone[0]) ? "goes down" : "changes";
      push(`The price ${dir} from ${gone[0]} to ${came[0]}.`);
    }
  }

  // 2. Money clauses that are new (in new paragraphs, or newly present in modified ones).
  const oldCats = new Set(runRules(splitParagraphs(removed.join("\n\n"))).map((h) => h.category));
  const newHits = runRules(splitParagraphs([...newOnly, ...pairs.map((p) => p[1])].join("\n\n")));
  const seen = new Set<string>();
  for (const h of newHits) {
    if (oldCats.has(h.category) || seen.has(h.category)) continue;
    seen.add(h.category);
    const amount = findMoney(h.quote)[0];
    push(`New: ${CATEGORY_LABEL[h.category].toLowerCase()}${amount ? " of " + amount : ""} (${h.title.toLowerCase()}).`);
  }

  // 3. Money clauses that disappeared.
  const newCats = new Set(newHits.map((h) => h.category));
  const remaining = runRules(splitParagraphs(added.join("\n\n"))).map((h) => h.category);
  for (const c of oldCats) {
    if (!newCats.has(c) && !remaining.includes(c)) push(`Removed: ${CATEGORY_LABEL[c].toLowerCase()} clause.`);
  }

  // 4. New amounts in brand-new paragraphs not covered above.
  if (bullets.length === 0) {
    const amounts = newOnly.flatMap(findMoney);
    if (amounts.length) push(`New amounts mentioned: ${[...new Set(amounts)].slice(0, 3).join(", ")}.`);
  }

  if (bullets.length === 0) {
    const n = added.length + unpairedRemoved.length;
    push(
      isMoneyRelevant(added, removed)
        ? `Wording changed in ${n} paragraph${n === 1 ? "" : "s"} about payments or cancellation.`
        : `Wording changed in ${n} paragraph${n === 1 ? "" : "s"}; nothing about prices or fees.`,
    );
  }
  return bullets.slice(0, 3);
}
