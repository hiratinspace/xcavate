/**
 * Drawn icons for the card and popup (no unicode glyphs as icons). Each is a 20x20 SVG built with
 * createElementNS, so it works in the closed shadow root and in the popup without innerHTML.
 */
const NS = "http://www.w3.org/2000/svg";

type Shape = [tag: string, attrs: Record<string, string>];

const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round" };

/** Verdict marks: a solid state-coloured tile with a paper-white sign, like a label's warning box. */
const TILE: Shape = ["rect", { x: "1", y: "1", width: "18", height: "18", rx: "2.5", fill: "currentColor" }];
const ON_TILE = { fill: "none", stroke: "#fff", "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" };

const SHAPES: Record<string, Shape[]> = {
  red: [TILE, ["path", { ...ON_TILE, d: "M10 5.2v6.2" }], ["circle", { cx: "10", cy: "14.6", r: "1.45", fill: "#fff" }]],
  yellow: [TILE, ["path", { ...ON_TILE, d: "M5.5 10h9" }], ["path", { ...ON_TILE, "stroke-width": "1.6", d: "M5.5 13.6h9M5.5 6.4h9" }]],
  green: [TILE, ["path", { ...ON_TILE, d: "M5.6 10.4l3 3 5.8-6.6" }]],
  partial: [
    ["rect", { x: "2", y: "2", width: "16", height: "16", rx: "2", fill: "none", stroke: "currentColor", "stroke-width": "2" }],
    ["path", { d: "M2 10h16v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z", fill: "currentColor" }],
  ],
  unknown: [
    ["rect", { x: "2", y: "2", width: "16", height: "16", rx: "2", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-dasharray": "3.2 2.4" }],
    ["path", { ...STROKE, "stroke-width": "2", d: "M7.6 7.8a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5" }],
    ["circle", { cx: "10", cy: "14.4", r: "1.2", fill: "currentColor" }],
  ],
  checking: [
    ["rect", { x: "2", y: "2", width: "16", height: "16", rx: "2", fill: "none", stroke: "currentColor", "stroke-width": "2" }],
    ["path", { d: "M2 12.5h16M2 15.5h16", stroke: "currentColor", "stroke-width": "1.6" }],
  ],
  /** The brand mark: a magnifier over three earth strata. */
  mark: [
    ["path", { d: "M1.5 17h17", stroke: "#B48E6B", "stroke-width": "2" }],
    ["path", { d: "M1.5 13.6h17", stroke: "#8A6A52", "stroke-width": "1.6" }],
    ["circle", { cx: "8", cy: "7.6", r: "5.2", fill: "#fff", stroke: "currentColor", "stroke-width": "2.2" }],
    ["path", { ...STROKE, "stroke-width": "2.6", d: "M11.9 11.5l4.4 4.4" }],
  ],
  close: [["path", { ...STROKE, d: "M5 5l10 10M15 5L5 15" }]],
  left: [["path", { ...STROKE, d: "M12.5 4.5L7 10l5.5 5.5" }]],
  right: [["path", { ...STROKE, d: "M7.5 4.5L13 10l-5.5 5.5" }]],
};

export type IconName = keyof typeof SHAPES;

export function icon(d: Document, name: IconName, cls = ""): SVGSVGElement {
  const svg = d.createElementNS(NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (cls) svg.setAttribute("class", cls);
  for (const [tag, attrs] of SHAPES[name] ?? []) {
    const node = d.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
}
