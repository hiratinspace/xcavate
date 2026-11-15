import { JSDOM } from "jsdom";
import type { MiniElement, MiniNode, MiniStyle } from "jsdom";
import { LIMITS } from "@xcavate/shared";

/**
 * Server-side policy HTML to plain text, mirroring the extension's extractor
 * (section 7.3). Used by the seed script, the eval and tests. Hidden text is a
 * prompt-injection route, so anything hidden is removed before reading.
 */

const DROP =
  "script, style, noscript, svg, nav, header, footer, form, iframe, template, object, embed, canvas, button, select";

const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY",
  "THEAD", "TFOOT", "TR", "UL", "DETAILS", "SUMMARY", "BODY", "CAPTION",
]);

const ZERO = /^0(\.0+)?(px|em|rem|pt|%)?$/;

/** Inline-style checks: display:none, visibility:hidden, font-size:0, opacity:0, off-screen tricks. */
export function styleHides(style: string): boolean {
  const decls = new Map<string, string>();
  for (const d of style.toLowerCase().split(";")) {
    const i = d.indexOf(":");
    if (i < 0) continue;
    decls.set(d.slice(0, i).trim(), d.slice(i + 1).replace(/!important/g, "").trim());
  }
  const v = (k: string) => decls.get(k) ?? "";
  if (v("display") === "none") return true;
  if (v("visibility") === "hidden" || v("visibility") === "collapse") return true;
  if (ZERO.test(v("font-size"))) return true;
  if (ZERO.test(v("opacity"))) return true;
  if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(v("clip"))) return true;
  if ((ZERO.test(v("height")) || ZERO.test(v("max-height")) || ZERO.test(v("width"))) && v("overflow") === "hidden") return true;
  for (const k of ["left", "top", "text-indent", "margin-left"]) if (/^-\d{3,}(px|em|rem)$/.test(v(k))) return true;
  return false;
}

function isHidden(el: MiniElement, getStyle: (el: MiniElement) => MiniStyle): boolean {
  if (el.hasAttribute("hidden")) return true;
  if ((el.getAttribute("aria-hidden") ?? "").toLowerCase() === "true") return true;
  const inline = el.getAttribute("style");
  if (inline && styleHides(inline)) return true;
  // Stylesheet rules: jsdom applies the cascade for these basic properties.
  try {
    const cs = getStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return true;
    if (ZERO.test(cs.fontSize)) return true;
    if (cs.opacity !== "" && Number.parseFloat(cs.opacity) === 0) return true;
  } catch {
    // ignore style errors
  }
  return false;
}

export interface ExtractResult {
  text: string;
  readable: boolean;
}

export function htmlToText(html: string): ExtractResult {
  const { window } = new JSDOM(html);
  const doc = window.document;
  try {
    // Hidden check first, while <style> sheets are still in the document for the cascade.
    const hidden = Array.from(doc.querySelectorAll("body *")).filter((el) => isHidden(el, (e) => window.getComputedStyle(e)));
    for (const el of hidden) el.remove();
    for (const el of Array.from(doc.querySelectorAll(DROP))) el.remove();
    const parts: string[] = [];
    const walk = (n: MiniNode) => {
      if (n.nodeType === 3) {
        parts.push(n.textContent ?? "");
        return;
      }
      if (n.nodeType !== 1) return;
      const block = BLOCK.has(n.nodeName);
      if (n.nodeName === "BR") parts.push("\n");
      if (block) parts.push("\n\n");
      for (const c of Array.from(n.childNodes)) walk(c);
      if (block) parts.push("\n\n");
      else if (n.nodeName === "TD" || n.nodeName === "TH") parts.push(" ");
    };
    if (doc.body) walk(doc.body);
    const text = parts
      .join("")
      .replace(/[ \t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, LIMITS.maxPolicyChars);
    return { text, readable: text.length >= LIMITS.minReadableChars };
  } finally {
    window.close();
  }
}
