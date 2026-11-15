/** Paragraphs above this size are split further so one huge block cannot eat the prefilter budget. */
export const MAX_PARAGRAPH_CHARS = 2_000;

export interface Paragraph {
  index: number;
  text: string;
}

function chunkSentences(block: string, max: number): string[] {
  const sentences = block.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) ?? [block];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
      continue;
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Split policy text into paragraphs on blank lines, numbered from 0 (section 7.4 step 1).
 * Deterministic, so the same text always yields the same indices.
 * Whitespace inside a paragraph is collapsed to single spaces.
 */
export function splitParagraphs(text: string): Paragraph[] {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n+/);
  const pieces: string[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    if (block.length <= MAX_PARAGRAPH_CHARS) {
      pieces.push(block);
      continue;
    }
    for (const line of block.split(/\n/)) {
      const l = line.trim();
      if (!l) continue;
      if (l.length <= MAX_PARAGRAPH_CHARS) pieces.push(l);
      else pieces.push(...chunkSentences(l, MAX_PARAGRAPH_CHARS));
    }
  }
  return pieces.map((p, index) => ({ index, text: p.replace(/\s+/g, " ").trim() })).filter((p) => p.text);
}
