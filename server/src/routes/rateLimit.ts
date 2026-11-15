import type { NextFunction, Request, Response } from "express";

/** Fixed one-minute window per client IP (A-09). In memory; fine for one process. */
export function rateLimit(perMinute: number, now: () => number = Date.now) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const t = now();
    let h = hits.get(ip);
    if (!h || t - h.windowStart >= 60_000) {
      h = { windowStart: t, count: 0 };
      hits.set(ip, h);
      if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.windowStart >= 60_000) hits.delete(k);
    }
    h.count++;
    if (h.count > perMinute) {
      res.setHeader("Retry-After", String(Math.ceil((h.windowStart + 60_000 - t) / 1000)));
      res.status(429).json({ error: "Too many requests. Try again in a minute." });
      return;
    }
    next();
  };
}
