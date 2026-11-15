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
 *   :8787          a request-counting proxy (the extension's default apiBase)
 *   :8788          the real backend (mock LLM, temp DB), reached only through the proxy
 *
 * The proxy is how the specs see what the service worker sends to the backend: every request
 * (including 404 report lookups, which the backend does not log) is recorded with its method,
 * path and domain. Stopping the proxy and the backend makes :8787 refuse connections, which is
 * what the extension sees when the real service is down.
 */

export const ROOT = resolve(import.meta.dirname, "../..");
export const FIXTURE_PORT = 4000;
export const LEGAL_PORT = 4001;
export const API_PORT = 8787;
export const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 8788);

export interface ApiCall {
  method: string;
  path: string;
  /** For POST /v1/analyze: the request body's pageUrl; for GET /v1/report: the domain param. */
  target?: string;
  status?: number;
  at: number;
}

async function portBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = net.createServer();
    s.once("error", () => done(true));
    s.once("listening", () => s.close(() => done(false)));
    s.listen(port, "127.0.0.1");
  });
}

export async function assertPortsFree(): Promise<void> {
  const busy: number[] = [];
  for (const p of [FIXTURE_PORT, LEGAL_PORT, API_PORT, BACKEND_PORT]) if (await portBusy(p)) busy.push(p);
  if (busy.length) {
    throw new Error(
      `e2e needs ports ${[FIXTURE_PORT, LEGAL_PORT, API_PORT, BACKEND_PORT].join(", ")} free, but ${busy.join(", ")} ` +
        `${busy.length > 1 ? "are" : "is"} in use. Stop \`npm run dev:fixtures\` / \`npm run dev:server\` (or whatever holds them: ` +
        `\`lsof -nP -iTCP:${busy[0]} -sTCP:LISTEN\`) and run again. The fixture stores hard-code :4000/:4001 and the ` +
        `extension's default service address is http://localhost:8787.`,
    );
  }
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
  private fixtures?: ChildProcess;
  private backend?: ChildProcess;
  private proxy?: http.Server;
  private sockets = new Set<net.Socket>();
  private dbDir = mkdtempSync(join(tmpdir(), "xcavate-e2e-db-"));
  backendLog = "";

  async start(): Promise<void> {
    await assertPortsFree();
    await this.startFixtures();
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
        const up = http.request(
          { host: "127.0.0.1", port: BACKEND_PORT, method: req.method, path: req.url, headers: req.headers },
          (ur) => {
            call.status = ur.statusCode;
            res.writeHead(ur.statusCode ?? 502, ur.headers);
            ur.pipe(res);
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
