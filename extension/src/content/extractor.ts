import { LIMITS } from "@xcavate/shared";

/**
 * D-04 policy text extraction (BUILD_PLAN 7.3).
 * Hidden text is a prompt-injection route, so anything hidden is dropped before the text leaves.
 */

export interface Extracted {
  text: string;
  readable: boolean;
}

// Forms are handled separately (see dropSmallForms): ASP.NET sites wrap the whole page in one.
const DROP = "script, style, noscript, svg, nav, header, footer, iframe, template, object, embed, canvas, button, select, textarea, input, option, datalist";
const HIDDEN_ATTR = '[hidden], [aria-hidden="true"], [inert]';

const HIDDEN_STYLE = [
  /display\s*:\s*none/i,
  /visibility\s*:\s*(hidden|collapse)/i,
  /font-size\s*:\s*0(\.0+)?(px|em|rem|pt|%)?\s*(!important)?\s*(;|$)/i,
  /opacity\s*:\s*0(\.0+)?\s*(!important)?\s*(;|$)/i,
  /clip\s*:\s*rect\(\s*0/i,
  /clip-path\s*:\s*inset\(\s*50%/i,
  /(left|top|text-indent)\s*:\s*-\d{4,}px/i,
];

export function isHiddenStyle(style: string): boolean {
  return HIDDEN_STYLE.some((re) => re.test(style));
}

const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY",
  "THEAD", "TFOOT", "TR", "UL", "DETAILS", "SUMMARY", "CAPTION",
]);

/** Remove elements that the page's own <style> blocks hide with simple rules (e.g. `.x{display:none}`). */
function removeStylesheetHidden(root: Document | Element): void {
  const styles = Array.from(root.querySelectorAll("style"));
  for (const s of styles) {
    const css = (s.textContent ?? "").replace(/\/\*[^]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      if (!isHiddenStyle(m[2])) continue;
      for (const sel of m[1].split(",")) {
        const selector = sel.trim();
        if (!selector || /^(html|body|\*|:root)$/i.test(selector)) continue;
        try {
          root.querySelectorAll(selector).forEach((el) => el.remove());
        } catch {
          /* selector jsdom or the browser cannot parse; ignore */
        }
      }
    }
  }
}

/** Strip a parsed document (or a detached clone) in place, then return its clean text. */
export function extractFromDocument(doc: Document): Extracted {
  removeStylesheetHidden(doc);
  const body = doc.body ?? doc.documentElement;
  return extractFromRoot(body);
}

/**
 * Drop forms (newsletter boxes, search, sign-in), except a form that holds most of the page:
 * ASP.NET WebForms wraps the entire body in <form id="aspnetForm">, and removing it would
 * wipe the policy. Kept forms still lose their controls via DROP.
 */
function dropSmallForms(root: Element): void {
  const total = (root.textContent ?? "").replace(/\s+/g, " ").length || 1;
  // Outermost forms first; a removed form takes its nested forms with it.
  for (const form of Array.from(root.querySelectorAll("form"))) {
    if (!root.contains(form)) continue; // already removed with an outer form
    const len = (form.textContent ?? "").replace(/\s+/g, " ").length;
    if (len / total < 0.5) form.remove();
  }
}

export function extractFromRoot(root: Element): Extracted {
  root.querySelectorAll(DROP).forEach((el) => el.remove());
  root.querySelectorAll(HIDDEN_ATTR).forEach((el) => el.remove());
  root.querySelectorAll("[style]").forEach((el) => {
    if (isHiddenStyle(el.getAttribute("style") ?? "")) el.remove();
  });
  dropSmallForms(root); // last, so scripts, controls and hidden text don't count as page text

  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === "BR") {
      out.push("\n");
      return;
    }
    const block = BLOCK.has(tag);
    if (block) out.push("\n\n");
    else if (tag === "TD" || tag === "TH") out.push(" ");
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block) out.push("\n\n");
  };
  walk(root);

  const text = tidy(out.join(""));
  const capped = text.length > LIMITS.maxPolicyChars ? text.slice(0, LIMITS.maxPolicyChars) : text;
  return { text: capped, readable: capped.length >= LIMITS.minReadableChars };
}

/** Collapse runs of spaces, keep one blank line between blocks. */
export function tidy(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ​]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse an HTML string with DOMParser and extract its text. */
export function extractFromHtml(html: string): Extracted {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return extractFromDocument(doc);
}

/**
 * D-05: text of the live page the user is looking at. Works on a clone so the page is never
 * changed, and uses computed styles from the live page to drop text that is hidden by CSS.
 */
export function extractLiveDocument(doc: Document, excludeIds: string[] = []): Extracted {
  const liveRoot = doc.body ?? doc.documentElement;
  const clone = liveRoot.cloneNode(true) as Element;
  const view = doc.defaultView;
  if (view && typeof view.getComputedStyle === "function") {
    const live = Array.from(liveRoot.querySelectorAll("*"));
    const copies = Array.from(clone.querySelectorAll("*"));
    if (live.length === copies.length) {
      const toRemove: Element[] = [];
      for (let i = 0; i < live.length && i < 20000; i++) {
        const cs = view.getComputedStyle(live[i]);
        if (
          cs.display === "none" ||
          cs.visibility === "hidden" ||
          cs.opacity === "0" ||
          cs.fontSize === "0px"
        )
          toRemove.push(copies[i]);
      }
      toRemove.forEach((el) => el.remove());
    }
  }
  for (const id of excludeIds) clone.querySelectorAll("#" + id).forEach((el) => el.remove());
  removeStylesheetHidden(clone);
  return extractFromRoot(clone);
}
