// Xcavate fixture stores. Plain node:http, no dependencies.
// Contract: fixtures/README.md
//
//   http://<site>.localhost:4000/<page>   one store per host (Chrome resolves *.localhost)
//   http://localhost:4000/<site>/<page>   path-prefix fallback for Node tools
//   http://legal.localhost:4001/<site>/<page>   second origin for cross-origin policy fetches
//   GET /__set?site=streamnest&v=2        swap StreamNest terms + subscription to .v2.html
//   GET /__state                          current versions as JSON
//
// Ports can be overridden with FIXTURE_PORT / FIXTURE_LEGAL_PORT (0 = random free port).

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(ROOT, "sites");
const PAGES_DIR = join(ROOT, "pages");

const STORES = {
  streamnest: "StreamNest: video streaming free-trial signup (subscription traps)",
  gadgetly: "Gadgetly: one-off electronics purchase (return costs, arbitration, checkout fees)",
  fairbox: "FairBox: clean control store (should be green)",
  sneakyterms: "SneakyTerms: prompt-injection attack store",
  shopapp: "ShopApp: single-page app, checkout via history.pushState",
  privacyonly: "PrivacyOnly: readable privacy page without a money policy",
  unreadable: "Unreadable: linked terms return 404",
};
/** Plain articles (classifier negatives) are served as a pseudo-site called "pages". */
const ALL_SITES = [...Object.keys(STORES), "pages"];

/** Pages that /__set can swap to a .v2.html variant. */
const VERSIONED = { streamnest: ["terms", "subscription"] };
const state = { streamnest: 1 };

const PAGE_RE = /^[a-z0-9-]+(\.v2)?$/i;

function siteDir(site) {
  return site === "pages" ? PAGES_DIR : join(SITES_DIR, site);
}

async function loadPage(site, rawName) {
  let name = rawName.replace(/\.html$/i, "").replace(/\/+$/, "") || "index";
  if (!PAGE_RE.test(name)) return null;
  if (VERSIONED[site]?.includes(name) && state[site] === 2) name = `${name}.v2`;
  try {
    return (await readFile(join(siteDir(site), `${name}.html`), "utf8")).replaceAll("http://localhost:4000/\">← Xcavate demo room", `http://localhost:${ports.main}/\">← Xcavate demo room`);
  } catch {
    // ShopApp is an SPA: a reload on /checkout (or any unknown route) serves the app shell.
    if (site === "shopapp") {
      try {
        return await readFile(join(siteDir(site), "index.html"), "utf8");
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** In path-prefix mode, root-relative links ("/terms") must point inside "/<site>/". */
function rewriteForPrefix(html, site) {
  return html.replace(/\b(href|src|action)="\/(?!\/|demo\/)/g, `$1="/${site}/`);
}

function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  });
  res.end(body);
}

function notFound(res, what) {
  send(res, 404, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>404</h1><p>No fixture page at ${escapeHtml(what)}.</p><p><a href="http://localhost:${ports.main}/">All fixture stores</a></p></body></html>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function indexPage() {
  const m = ports.main;
  const l = ports.legal;
  const rows = Object.entries(STORES)
    .map(
      ([id, desc]) => `<li><strong><a href="http://${id}.localhost:${m}/${["privacyonly", "unreadable"].includes(id) ? "checkout" : ""}">${id}.localhost:${m}</a></strong>: ${escapeHtml(desc)}
  <br><a href="http://${id}.localhost:${m}/checkout">checkout</a> · path-prefix: <a href="/${id}/${["privacyonly", "unreadable"].includes(id) ? "checkout" : ""}">/${id}/</a> · <a href="/${id}/checkout">/${id}/checkout</a></li>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Xcavate fixture stores</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px}li{margin:0 0 12px}code{background:#f2f2f2;padding:1px 4px}</style></head>
<body>
<h1>Xcavate fixture stores</h1>
<p>All brands here are fictional. No form on any page submits anywhere.</p>
<ul>
${rows}
</ul>
<h2>Articles (classifier negatives)</h2>
<ul>
<li><a href="/pages/article-1">/pages/article-1</a></li>
<li><a href="/pages/article-2">/pages/article-2</a></li>
<li><a href="/pages/article-3">/pages/article-3</a></li>
<li><a href="/pages/article-4">/pages/article-4</a> (plan prices in prose)</li>
</ul>
<h2>Real-world patterns (direction v3)</h2>
<ul>
<li><a href="/pages/plans-saas">/pages/plans-saas</a>, <a href="/pages/trial-stream">/pages/trial-stream</a>, <a href="/pages/signup-steps">/pages/signup-steps</a>, <a href="/pages/plans-hydrated">/pages/plans-hydrated</a> (should qualify)</li>
<li><a href="/pages/cart-empty">/pages/cart-empty</a>, <a href="/pages/docs-1">/pages/docs-1</a> (should stay silent)</li>
</ul>
<h2>Cross-origin legal host</h2>
<p><a href="http://legal.localhost:${l}/streamnest/terms">http://legal.localhost:${l}/streamnest/terms</a></p>
<h2>Policy version toggle</h2>
<p>StreamNest is on <strong>v${state.streamnest}</strong>. <a href="/__set?site=streamnest&amp;v=2">Switch to v2</a> · <a href="/__set?site=streamnest&amp;v=1">Switch to v1</a> · <a href="/__state">/__state</a></p>
</body></html>`;
}

const DEMO_ASSETS = { "demo.css": "text/css; charset=utf-8", "demo.js": "text/javascript; charset=utf-8", "store.css": "text/css; charset=utf-8" };

async function demoPage() {
  const html = await readFile(join(ROOT, "demo", "index.html"), "utf8");
  return html.replace("</head>", `<meta name="legal-port" content="${ports.legal}"></head>`);
}

async function serveDemoAsset(url, res) {
  const name = url.pathname.slice("/demo/".length);
  if (!Object.hasOwn(DEMO_ASSETS, name)) return notFound(res, url.pathname);
  send(res, 200, await readFile(join(ROOT, "demo", name), "utf8"), DEMO_ASSETS[name]);
}

function handleControl(url, res) {
  if (url.pathname === "/__state") {
    send(res, 200, JSON.stringify(state), "application/json; charset=utf-8");
    return true;
  }
  if (url.pathname === "/__set") {
    const site = url.searchParams.get("site");
    const v = Number(url.searchParams.get("v"));
    if (!(site in state) || (v !== 1 && v !== 2)) {
      send(res, 400, JSON.stringify({ error: "use /__set?site=streamnest&v=1|2" }), "application/json; charset=utf-8");
      return true;
    }
    state[site] = v;
    console.log(`[fixtures] ${site} -> v${v}`);
    send(res, 200, JSON.stringify(state), "application/json; charset=utf-8");
    return true;
  }
  return false;
}

/** Serve /<site>/<page> (path-prefix mode). */
async function servePrefixed(url, res) {
  const parts = url.pathname.split("/").filter(Boolean);
  const site = parts[0];
  if (!ALL_SITES.includes(site)) return notFound(res, url.pathname);
  if (parts.length === 1 && !url.pathname.endsWith("/")) {
    res.writeHead(301, { Location: `/${site}/`, "Cache-Control": "no-store" });
    return res.end();
  }
  const html = await loadPage(site, parts.slice(1).join("/"));
  if (html == null) return notFound(res, url.pathname);
  send(res, 200, rewriteForPrefix(html, site));
}

function hostName(req) {
  return String(req.headers.host || "localhost").replace(/:\d+$/, "").toLowerCase();
}

async function handleMain(req, res) {
  const url = new URL(req.url, "http://x");
  if (handleControl(url, res)) return;
  if (url.pathname.startsWith("/demo/")) return serveDemoAsset(url, res);
  const host = hostName(req);
  const sub = host.endsWith(".localhost") ? host.slice(0, -".localhost".length) : null;
  if (sub && ALL_SITES.includes(sub)) {
    const html = await loadPage(sub, url.pathname.slice(1));
    if (html == null) return notFound(res, host + url.pathname);
    return send(res, 200, html);
  }
  if (url.pathname === "/") return send(res, 200, await demoPage());
  if (url.pathname === "/fixtures") return send(res, 200, indexPage());
  return servePrefixed(url, res);
}

async function handleLegal(req, res) {
  const url = new URL(req.url, "http://x");
  if (handleControl(url, res)) return;
  if (url.pathname === "/") return send(res, 200, indexPage());
  return servePrefixed(url, res);
}

function wrap(handler) {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
    handler(req, res).catch((err) => {
      console.error("[fixtures]", err);
      if (!res.headersSent) send(res, 500, "Internal error", "text/plain");
    });
  };
}

const ports = {
  main: Number(process.env.FIXTURE_PORT ?? 4000),
  legal: Number(process.env.FIXTURE_LEGAL_PORT ?? 4001),
};

const mainServer = http.createServer(wrap(handleMain));
const legalServer = http.createServer(wrap(handleLegal));

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server.address().port));
  });
}

try {
  ports.main = await listen(mainServer, ports.main);
  ports.legal = await listen(legalServer, ports.legal);
} catch (err) {
  console.error(`[fixtures] could not start: ${err.message}`);
  process.exit(1);
}

console.log(
  `[fixtures] stores on http://localhost:${ports.main} (http://<site>.localhost:${ports.main}), legal origin on http://legal.localhost:${ports.legal}`,
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    mainServer.close();
    legalServer.close();
    process.exit(0);
  });
}
