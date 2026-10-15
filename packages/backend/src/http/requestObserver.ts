import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "../logger.js";
import type { AppMetrics } from "../metrics/appMetrics.js";

/** An incoming id is reused only if it looks like one: bounded, and from a character set that
 *  cannot break a log line or smuggle anything into the aggregator. Anything else is replaced. */
const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Paths polled by machines every few seconds. Logged only when they fail, or the log would be
 *  mostly the Docker healthcheck talking to itself. Still counted in the metrics. */
const QUIET_PATHS = new Set(["/health", "/metrics"]);

/**
 * The route TEMPLATE a request matched — `/tasks/:id`, not `/tasks/abc123` — or "unmatched".
 *
 * Never the raw URL. The path can carry an id and the query string a phone number or a token,
 * and this value becomes both a metric label (a new series per distinct value, forever) and a
 * log field. A 404 for an unknown path is therefore one series, "unmatched", however many
 * different paths a scanner tries.
 */
export function routeTemplate(req: Request): string {
  const route = (req as Request & { route?: { path?: unknown } }).route;
  if (!route || route.path == null) return "unmatched";
  const path = typeof route.path === "string" ? route.path : "pattern";
  return `${req.baseUrl ?? ""}${path}`;
}

/**
 * Request id, structured access log and HTTP metrics, in one middleware mounted first.
 *
 * Measured on `finish`/`close` rather than when a handler returns: most handlers here are
 * async (see asyncRoute), so return time says nothing about when the client got its answer.
 * The route is read at the same moment, after routing has populated `req.route`.
 *
 * The log line carries method, route template, status and duration — and deliberately no user
 * id, IP or path. Correlating a request with a person is what the request id is for: it is
 * echoed in the `X-Request-Id` response header and in `res.locals.requestId`, so a support
 * report can quote it and the matching log lines can be found without the access log itself
 * becoming a record of who did what.
 */
export function requestObserver(deps: {
  metrics: AppMetrics;
  logger: Logger;
  /** Monotonic clock in ms. Injectable so a test can pin durations; defaults to hrtime. */
  clockMs?: () => number;
}): RequestHandler {
  const clock = deps.clockMs ?? (() => Number(process.hrtime.bigint()) / 1e6);
  return (req: Request, res: Response, next: NextFunction) => {
    const started = clock();
    const incoming = req.get("x-request-id");
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = requestId;
    res.set("X-Request-Id", requestId);

    let done = false;
    const record = (aborted: boolean): void => {
      if (done) return;
      done = true;
      const seconds = Math.max(0, clock() - started) / 1000;
      const method = KNOWN_METHODS.has(req.method) ? req.method : "OTHER";
      const route = routeTemplate(req);
      // A client that hung up before the response was written has no real status; 499 is the
      // conventional stand-in, and keeps these out of the 2xx series they would otherwise join.
      const status = aborted && !res.headersSent ? "499" : String(res.statusCode);
      const labels = { method, route, status };
      deps.metrics.httpRequests.inc(labels);
      deps.metrics.httpDuration.observe(labels, seconds);

      const failed = Number(status) >= 500;
      if (QUIET_PATHS.has(route) && !failed) return;
      const meta = {
        requestId,
        method,
        route,
        status: Number(status),
        durationMs: Math.round(seconds * 10_000) / 10,
      };
      if (failed) deps.logger.warn("http request", meta);
      else deps.logger.info("http request", meta);
    };
    res.once("finish", () => record(false));
    res.once("close", () => record(!res.writableFinished));
    next();
  };
}
