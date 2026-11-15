/**
 * Drawn icons for the card and popup (no unicode glyphs as icons). Each is a 20x20 SVG built with
 * createElementNS, so it works in the closed shadow root and in the popup without innerHTML.
 */
const NS = "http://www.w3.org/2000/svg";

/*
 * Compact encoding (the content script has a 60 KB budget): elements split by "|", attributes by
 * ";" as k=v. Presets: T = the verdict tile, W = white round stroke on it, S = round currentColor
 * stroke, B = the outlined box.
 */
const PRESET: Record<string, string> = {
  T: "rect;x=1;y=1;width=18;height=18;rx=2.5;fill=currentColor",
  W: "fill=none;stroke=#fff;stroke-width=2.4;stroke-linecap=round;stroke-linejoin=round",
  S: "fill=none;stroke=currentColor;stroke-width=2.2;stroke-linecap=round;stroke-linejoin=round",
  B: "rect;x=2;y=2;width=16;height=16;rx=2;fill=none;stroke=currentColor;stroke-width=2",
};

const SHAPES = {
  red: "T|path;W;d=M10 5.2v6.2|circle;cx=10;cy=14.6;r=1.45;fill=#fff",
  yellow: "T|path;W;d=M5.5 10h9|path;W;stroke-width=1.6;d=M5.5 13.6h9M5.5 6.4h9",
  green: "T|path;W;d=M5.6 10.4l3 3 5.8-6.6",
  partial: "B|path;fill=currentColor;d=M2 10h16v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z",
  unknown: "B;stroke-dasharray=3.2 2.4|path;S;stroke-width=2;d=M7.6 7.8a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5|circle;cx=10;cy=14.4;r=1.2;fill=currentColor",
  checking: "B|path;stroke=currentColor;stroke-width=1.6;d=M2 12.5h16M2 15.5h16",
  /** The brand mark: a magnifier over two earth strata. */
  mark: "path;stroke=#B48E6B;stroke-width=2;d=M1.5 17h17|path;stroke=#8A6A52;stroke-width=1.6;d=M1.5 13.6h17|circle;cx=8;cy=7.6;r=5.2;fill=#fff;stroke=currentColor;stroke-width=2.2|path;S;stroke-width=2.6;d=M11.9 11.5l4.4 4.4",
  close: "path;S;d=M5 5l10 10M15 5L5 15",
  left: "path;S;d=M12.5 4.5L7 10l5.5 5.5",
  right: "path;S;d=M7.5 4.5L13 10l-5.5 5.5",
};

export type IconName = keyof typeof SHAPES;

export function icon(d: Document, name: IconName, cls = ""): SVGSVGElement {
  const svg = d.createElementNS(NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (cls) svg.setAttribute("class", cls);
  for (const part of SHAPES[name].split("|")) {
    // Expand presets in place, then the first token is the tag and the rest are k=v (later wins).
    const [tag, ...attrs] = part.split(";").flatMap((t) => (PRESET[t] ?? t).split(";"));
    const node = d.createElementNS(NS, tag);
    for (const kv of attrs) {
      const i = kv.indexOf("=");
      node.setAttribute(kv.slice(0, i), kv.slice(i + 1));
    }
    svg.appendChild(node);
  }
  return svg;
}
