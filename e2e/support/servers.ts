import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Test servers for the e2e run.
 *
 *   :4000 / :4001  fixtures/server.mjs (the store URLs inside the fixtures assume these ports)
 *   :18787         a request-counting proxy; the harness points the extension's apiBase here
 *                  (chrome.storage settings) before any page loads, so :8787 stays free for
 *                  `npm run dev:server`
 *   :18788         the real backend (mock LLM, temp DB), reached only through the proxy
 *
 * The proxy is how the specs see what the service worker sends to the backend: every request
 * (including 404 report lookups, which the backend does not log) is recorded with its method,
 * path and domain. It also plays the service the shopper would really use (see ProxyMode):
 *   "model"     the default. The backend runs the mock (the same rules engine as the extension),
 *               so the proxy marks its reports as AI-checked (stats.usedLlm = true) and /healthz
 *               says a model runs. That makes the backend's report distinguishable from the
 *               on-device one (always usedLlm false), without changing product code.
 *   "rulesOnly" reports pass through untouched (usedLlm false) while /healthz still says a model
 *               runs: what the extension sees when the model timed out and the server fell back.
 *   "down"      every request is counted and answered 503: the service is unreachable.
 *
 * E2E_REUSE_FIXTURES=1 reuses fixture stores already running on :4000/:4001 (read-only: the
 * specs never switch fixture versions) instead of failing when those ports are busy.
 */

export const ROOT = resolve(import.meta.dirname, "../..");
export const FIXTURE_PORT = 4000;
export const LEGAL_PORT = 4001;
export const API_PORT = Number(process.env.E2E_API_PORT ?? 18787);
export const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 18788);
export const API_BASE = `http://localhost:${API_PORT}`;
const REUSE_FIXTURES = process.env.E2E_REUSE_FIXTURES === "1";

export type ProxyMode = "model" | "rulesOnly" | "down";

export interface ApiCall {
  method: string;
  path: string;
  /** For POST /v1/analyze: the request body's pageUrl; for GET /v1/report: the domain param. */
  target?: string;
  status?: number;
  at: number;
}

/** Something accepts connections on host:port. */
function answers(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const c = net.connect({ port, host });
    const end = (v: boolean) => {
      c.destroy();
      done(v);
    };
    c.setTimeout(1_000, () => end(false));
    c.once("connect", () => end(true));
    c.once("error", () => end(false));
  });
}

/**
 * Busy if anything listens on the port. Binding 127.0.0.1 alone is not enough: on macOS that
 * succeeds even while another process holds the IPv6 wildcard (*:4000), which is how
 * `npm run dev:fixtures` listens, and the specs would then silently talk to that server.
 */
async function portBusy(port: number): Promise<boolean> {
  if ((await answers(port, "127.0.0.1")) || (await answers(port, "::1"))) return true;
  return new Promise((done) => {
    const s = net.createServer();
    s.once("error", () => done(true));
    s.once("listening", () => s.close(() => done(false)));
    s.listen(port);
  });
}

/** Ports to check; returns true when running fixture stores should be reused instead of started. */
export async function assertPortsFree(): Promise<boolean> {
  const fixturesBusy = (await portBusy(FIXTURE_PORT)) || (await portBusy(LEGAL_PORT));
  const reuse = fixturesBusy && REUSE_FIXTURES;
  const ports = reuse ? [API_PORT, BACKEND_PORT] : [FIXTURE_PORT, LEGAL_PORT, API_PORT, BACKEND_PORT];
  const busy: number[] = [];
  for (const p of ports) if (await portBusy(p)) busy.push(p);
  if (busy.length) {
    const fixtureHint = busy.some((p) => p === FIXTURE_PORT || p === LEGAL_PORT)
      ? ` The fixture stores hard-code :${FIXTURE_PORT}/:${LEGAL_PORT}: stop \`npm run dev:fixtures\`, or set E2E_REUSE_FIXTURES=1 to use the running stores.`
      : "";
    throw new Error(
      `e2e needs ports ${ports.join(", ")} free, but ${busy.join(", ")} ${busy.length > 1 ? "are" : "is"} in use ` +
        `(see \`lsof -nP -iTCP:${busy[0]} -sTCP:LISTEN\`).${fixtureHint} The proxy and backend ports can be moved with ` +
        `E2E_API_PORT / E2E_BACKEND_PORT.`,
    );
  }
  return reuse;
}

async function waitForHttp(url: string, child: ChildProcess, name: string, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`${name} exited early with code ${child.exitCode}`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${name} did not answer ${url} within ${timeoutMs} ms`);
}

function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(t);
      done();
    });
    child.kill("SIGTERM");
  });
}

export class Servers {
  calls: ApiCall[] = [];
  /** How the proxy answers (see ProxyMode). */
  mode: ProxyMode = "model";
  private fixtures?: ChildProcess;
  private backend?: ChildProcess;
  private proxy?: http.Server;
  private sockets = new Set<net.Socket>();
  private dbDir = mkdtempSync(join(tmpdir(), "xcavate-e2e-db-"));
  backendLog = "";

  async start(): Promise<void> {
    const reuse = await assertPortsFree();
    if (reuse) {
      const r = await fetch(`http://localhost:${FIXTURE_PORT}/__state`).catch(() => undefined);
      if (!r?.ok) throw new Error(`E2E_REUSE_FIXTURES=1 but :${FIXTURE_PORT} is not the fixture server (no /__state)`);
      const state = (await r.json()) as { streamnest?: number };
      if (state.streamnest !== 1) throw new Error("the running fixture server is on StreamNest v" + state.streamnest + "; the specs expect v1");
    } else await this.startFixtures();
    await this.startBackend();
  }

  private async startFixtures(): Promise<void> {
    this.fixtures = spawn(process.execPath, [join(ROOT, "fixtures/server.mjs")], {
      cwd: ROOT,
      env: { ...process.env, FIXTURE_PORT: String(FIXTURE_PORT), FIXTURE_LEGAL_PORT: String(LEGAL_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.fixtures.stdout?.resume();
    this.fixtures.stderr?.resume();
    await waitForHttp(`http://localhost:${FIXTURE_PORT}/__state`, this.fixtures, "fixture server");
    await waitForHttp(`http://localhost:${LEGAL_PORT}/__state`, this.fixtures, "fixture legal host");
  }

  /** Backend (mock LLM, temp DB, client reports not published) behind the counting proxy. */
  async startBackend(): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(BACKEND_PORT),
      DB_PATH: join(this.dbDir, "xcavate.db"),
      LLM_PROVIDER: "mock",
      LLM_API_KEY: "",
      RATE_LIMIT_PER_MIN: "1000",
    };
    delete env.PUBLISH_CLIENT_REPORTS;
    delete env.XCAVATE_SILENT;
    this.backend = spawn(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "server/src/index.ts")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.backend.stdout?.on("data", (b) => (this.backendLog += String(b)));
    this.backend.stderr?.on("data", (b) => (this.backendLog += String(b)));
    await waitForHttp(`http://localhost:${BACKEND_PORT}/healthz`, this.backend, "backend");
    await this.startProxy();
  }

  private startProxy(): Promise<void> {
    this.proxy = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url ?? "/", "http://x");
        const call: ApiCall = { method: req.method ?? "GET", path: url.pathname, at: Date.now() };
        if (url.pathname === "/v1/report") call.target = url.searchParams.get("domain") ?? undefined;
        if (url.pathname === "/v1/analyze") {
          try {
            call.target = JSON.parse(body.toString("utf8")).pageUrl;
          } catch {
            /* not JSON */
          }
        }
        this.calls.push(call);
        const mode = this.mode;
        if (mode === "down") {
          call.status = 503;
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unavailable" }));
          return;
        }
        const up = http.request(
          { host: "127.0.0.1", port: BACKEND_PORT, method: req.method, path: req.url, headers: req.headers },
          (ur) => {
            call.status = ur.statusCode;
            const rewrite = url.pathname === "/healthz" || (url.pathname === "/v1/analyze" && mode === "model");
            if (!rewrite || ur.statusCode !== 200) {
              res.writeHead(ur.statusCode ?? 502, ur.headers);
              ur.pipe(res);
              return;
            }
            const parts: Buffer[] = [];
            ur.on("data", (c) => parts.push(c));
            ur.on("end", () => {
              let out = Buffer.concat(parts).toString("utf8");
              try {
                const j = JSON.parse(out);
                // The service the extension talks to runs a model; its analyze reports are AI-checked.
                if (url.pathname === "/healthz") j.llm = "anthropic";
                else j.stats = { ...j.stats, usedLlm: true };
                out = JSON.stringify(j);
              } catch {
                /* pass through */
              }
              const headers = { ...ur.headers, "content-length": String(Buffer.byteLength(out)) };
              res.writeHead(200, headers);
              res.end(out);
            });
          },
        );
        up.on("error", () => {
          call.status = 502;
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        up.end(body);
      });
    });
    this.proxy.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    return new Promise((done, fail) => {
      this.proxy!.once("error", fail);
      this.proxy!.listen(API_PORT, "127.0.0.1", () => done());
    });
  }

  /** Make the service unreachable: :8787 refuses connections, the backend process is gone. */
  async stopBackend(): Promise<void> {
    if (this.proxy) {
      const p = this.proxy;
      this.proxy = undefined;
      await new Promise<void>((done) => {
        p.close(() => done());
        for (const s of this.sockets) s.destroy();
      });
    }
    await stopChild(this.backend);
    this.backend = undefined;
  }

  /** Every proxied call to the backend's API (report lookups, analyze, health) from index `from` on. */
  apiCalls(from = 0): ApiCall[] {
    return this.calls.slice(from);
  }

  analyzeCalls(target?: string): ApiCall[] {
    return this.calls.filter((c) => c.path === "/v1/analyze" && (!target || (c.target ?? "").includes(target)));
  }

  callsFor(domainPart: string): ApiCall[] {
    return this.calls.filter((c) => (c.target ?? "").includes(domainPart));
  }

  async stop(): Promise<void> {
    await this.stopBackend();
    await stopChild(this.fixtures);
    rmSync(this.dbDir, { recursive: true, force: true });
  }
}
