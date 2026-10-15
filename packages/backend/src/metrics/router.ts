import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Logger } from "../logger.js";
import { asyncRoute } from "../http/asyncRoute.js";
import type { AppMetrics } from "./appMetrics.js";

/** The path the scraper reads. Caddy answers it with a 404 on the public API host. */
export const METRICS_PATH = "/metrics";

/**
 * Does `Authorization` carry exactly `Bearer <token>`?
 *
 * Both sides are hashed before comparing so `timingSafeEqual` always sees two 32-byte buffers:
 * comparing the raw strings would either throw on a length mismatch or need a length check
 * first, and that early return is itself a timing signal of how long the token is.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!token || typeof header !== "string") return false;
  const m = /^Bearer ([^\s]+)$/.exec(header);
  if (!m) return false;
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/**
 * GET /metrics, in Prometheus text format, for the scraper on the compose network only.
 *
 * Two locks, because the numbers here — how many alarms are open and for how long, how many
 * people are connected right now — are operational intelligence about a safety service:
 *   1. a bearer token (`METRICS_TOKEN`). With no token configured the route is not mounted at
 *      all and 404s like any unknown path, for the reason `/dev/token` does the same: a 401 or
 *      403 would confirm to a prober that something is there;
 *   2. Caddy refuses `/metrics` on the public API host (see the Caddyfile), so the token is a
 *      second line rather than the only one.
 * The token is read from the Authorization header only — never a query parameter, which would
 * land in access logs and browser history.
 */
export function createMetricsRouter(deps: {
  token: string;
  metrics: AppMetrics;
  logger: Logger;
}): Router {
  const router = Router();
  if (!deps.token) {
    deps.logger.info("metrics endpoint disabled (METRICS_TOKEN unset)");
    return router;
  }

  router.get(
    METRICS_PATH,
    asyncRoute(async (req: Request, res: Response) => {
      if (!bearerMatches(req.get("authorization"), deps.token)) {
        res.set("WWW-Authenticate", 'Bearer realm="metrics"');
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const { text, failed } = await deps.metrics.registry.render();
      for (const f of failed) {
        deps.metrics.collectorFailures.inc({ collector: f.name });
        deps.logger.warn("metrics collector failed", { collector: f.name, err: String(f.err) });
      }
      res.set("Cache-Control", "no-store");
      res.type("text/plain; version=0.0.4; charset=utf-8").send(text);
    }),
  );
  return router;
}
