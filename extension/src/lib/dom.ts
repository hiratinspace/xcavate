/** Small DOM helpers used by several content modules. None of them read what a user typed. */

export function cleanText(s: string | null | undefined): string {
  return (s ?? "").replace(/[\s ]+/g, " ").trim();
}

/** Visible label text of a form control: aria attributes, <label> elements, or the parent's text. */
export function controlLabel(el: Element): string {
  const doc = el.ownerDocument;
  const parts: string[] = [];
  const aria = el.getAttribute("aria-label");
  if (aria) parts.push(aria);
  const ids = el.getAttribute("aria-labelledby");
  if (ids) for (const id of ids.split(/\s+/)) parts.push(doc.getElementById(id)?.textContent ?? "");
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) for (const l of Array.from(labels)) parts.push(l.textContent ?? "");
  else {
    const wrap = el.closest("label");
    if (wrap) parts.push(wrap.textContent ?? "");
  }
  if (!cleanText(parts.join(" ")) && el.parentElement) parts.push(el.parentElement.textContent ?? "");
  return cleanText(parts.join(" ")).slice(0, 200);
}

/** Caption of a button-like element. For submit/button inputs the caption lives in an attribute. */
export function buttonText(el: Element): string {
  if (el.tagName === "INPUT") {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type !== "submit" && type !== "button") return "";
    return cleanText(el.getAttribute("value") ?? el.getAttribute("aria-label") ?? "");
  }
  return cleanText(el.textContent || el.getAttribute("aria-label") || "");
}

/** The element that best represents a control visually: its label if it has one, else itself. */
export function visualTarget(el: Element): Element {
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) return labels[0];
  return el.closest("label") ?? el;
}
