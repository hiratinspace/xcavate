// Builds the extension into extension/dist: bundles content, background and popup with esbuild,
// copies manifest + HTML + CSS, and draws the PNG icons. `node build.mjs --watch` rebuilds on change.
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, watch as fsWatch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const watchMode = process.argv.includes("--watch");

/** `import css from "./x.css?inline"` → the file's text (same syntax Vite uses in tests). */
const inlineCss = {
  name: "inline-css",
  setup(build) {
    build.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
      path: join(args.resolveDir, args.path.replace(/\?inline$/, "")),
      namespace: "inline-css",
    }));
    build.onLoad({ filter: /.*/, namespace: "inline-css" }, (args) => ({
      contents: readFileSync(args.path, "utf8"),
      loader: "text",
      watchFiles: [args.path],
    }));
  },
};

const common = {
  bundle: true,
  target: "chrome116",
  sourcemap: watchMode ? "inline" : false,
  minify: !watchMode,
  legalComments: "none",
  logLevel: "info",
  plugins: [inlineCss],
};

const entries = [
  { entryPoints: [join(here, "src/content/index.ts")], outfile: join(dist, "content.js"), format: "iife" },
  { entryPoints: [join(here, "src/background/index.ts")], outfile: join(dist, "background.js"), format: "esm" },
  { entryPoints: [join(here, "src/popup/popup.ts")], outfile: join(dist, "popup.js"), format: "esm" },
];

function copyStatic() {
  mkdirSync(join(dist, "icons"), { recursive: true });
  copyFileSync(join(here, "manifest.json"), join(dist, "manifest.json"));
  copyFileSync(join(here, "src/popup/popup.html"), join(dist, "popup.html"));
  copyFileSync(join(here, "src/popup/popup.css"), join(dist, "popup.css"));
  for (const size of [16, 32, 48, 128]) writeFileSync(join(dist, "icons", `icon${size}.png`), drawIcon(size));
}

// ---------- Tiny PNG encoder + icon drawing (no dependencies) ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const INK = hex("#1E2B30");
const SAND = hex("#D9CBA9");
const CLAY = hex("#B48E6B");
const LOAM = hex("#8A6A52");
const LENS = hex("#F1F3EF");

/** Colour at a point in unit coordinates, or null for transparent. A magnifier over earth strata. */
function shade(x, y) {
  // Rounded-square tile.
  const r = 0.2;
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  if (dx * dx + dy * dy > r * r) return null;

  const cx = 0.43, cy = 0.42, ringR = 0.25, ringW = 0.085;
  const d = Math.hypot(x - cx, y - cy);
  // Handle: a thick segment towards the bottom-right corner.
  const hx0 = cx + Math.SQRT1_2 * (ringR + ringW / 2), hy0 = cy + Math.SQRT1_2 * (ringR + ringW / 2);
  const hx1 = 0.84, hy1 = 0.83;
  const t = Math.max(0, Math.min(1, ((x - hx0) * (hx1 - hx0) + (y - hy0) * (hy1 - hy0)) / ((hx1 - hx0) ** 2 + (hy1 - hy0) ** 2)));
  const hd = Math.hypot(x - (hx0 + t * (hx1 - hx0)), y - (hy0 + t * (hy1 - hy0)));
  if (hd < 0.075) return LENS;
  if (Math.abs(d - ringR) < ringW / 2) return LENS;
  // Strata: inside the lens they show bright (dug up); outside they are dimmer.
  const inLens = d < ringR - ringW / 2;
  let layer = null;
  if (y > 0.5 && y <= 0.6) layer = SAND;
  else if (y > 0.6 && y <= 0.7) layer = CLAY;
  else if (y > 0.7) layer = LOAM;
  if (inLens) return layer ?? hex("#3C5058");
  if (layer) return layer.map((c, i) => Math.round(c * 0.45 + INK[i] * 0.55));
  return INK;
}

function drawIcon(size) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      const o = (py * size + px) * 4;
      if (a) {
        buf[o] = Math.round(r / a);
        buf[o + 1] = Math.round(g / a);
        buf[o + 2] = Math.round(b / a);
      }
      buf[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  return encodePng(size, size, buf);
}

// ---------- Build ----------

if (!watchMode) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyStatic();

if (watchMode) {
  const ctxs = await Promise.all(entries.map((e) => esbuild.context({ ...common, ...e })));
  await Promise.all(ctxs.map((c) => c.watch()));
  for (const f of ["manifest.json", "src/popup/popup.html", "src/popup/popup.css"]) {
    fsWatch(join(here, f), () => {
      try {
        copyStatic();
        console.log("[xcavate] copied", f);
      } catch (e) {
        console.error(e);
      }
    });
  }
  console.log("[xcavate] watching for changes…");
} else {
  await Promise.all(entries.map((e) => esbuild.build({ ...common, ...e })));
  console.log("[xcavate] built", dist);
}
