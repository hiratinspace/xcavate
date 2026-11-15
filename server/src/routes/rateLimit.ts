import type { NextFunction, Request, Response } from "express";

/** Hard cap on tracked clients; past it, expired windows are dropped, and if still full the map resets. */
export const MAX_TRACKED_CLIENTS = 10_000;

/** Fixed one-minute window per client IP (A-09). In memory; fine for one process. */
export function rateLimit(perMinute: number, now: () => number = Date.now, maxClients = MAX_TRACKED_CLIENTS) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const t = now();
    let h = hits.get(ip);
    if (!h || t - h.windowStart >= 60_000) {
      h = { windowStart: t, count: 0 };
      hits.set(ip, h);
      if (hits.size > maxClients) {
        for (const [k, v] of hits) if (t - v.windowStart >= 60_000) hits.delete(k);
        // Still full (many clients inside one minute): reset rather than grow without bound.
        if (hits.size > maxClients) {
          hits.clear();
          hits.set(ip, h);
        }
      }
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
