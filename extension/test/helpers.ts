/** Parse an HTML string into a standalone document (like DOMParser in the content script). */
export function htmlDoc(html: string, url = "https://shop.example/checkout"): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Give relative links a base, like a real page would have.
  const base = doc.createElement("base");
  base.href = url;
  doc.head.prepend(base);
  return doc;
}

/** Replace the live jsdom document with this HTML (for tests that need window, events, sessionStorage). */
export function setLiveDocument(html: string): Document {
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  return document;
}

export const LONG_POLICY_PARAGRAPH =
  "These terms explain how orders, payments, deliveries and returns work at our store. Please read them carefully before you buy anything. ";
