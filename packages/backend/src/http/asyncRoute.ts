import type { NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "../logger.js";

/**
 * Wrap an async Express handler so a rejection can never be dropped.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Express 4 does not understand promises. It calls a handler and ignores the return value, so
 * an `async (req, res) => …` that rejects produces an unhandled rejection and — critically —
 * NEVER SENDS A RESPONSE. The client does not get a 500; it gets nothing, and hangs until its
 * own timeout. On a phone on a bad connection that is indistinguishable from the network being
 * down, which for this product means an elderly user staring at a spinner instead of being told
 * something went wrong and to try again.
 *
 * That is precisely the class `@typescript-eslint/no-misused-promises` flags on every
 * `router.get(path, async …)` in this codebase. Most handlers here already try/catch their whole
 * body and are safe in practice, but "safe because every author remembered" is not a property —
 * `GET /auth/me` and `PATCH /auth/me` had no try/catch at all, so a database blip on either one
 * hung the request. Wrapping at the seam makes the guarantee structural: it holds for handlers
 * nobody has written yet.
 *
 * The wrapper deliberately RESPONDS rather than delegating to `next(err)`. A default Express
 * error handler leaks a stack trace in some configurations, and there is no app-level error
 * handler here to hand the error to; a JSON 500 with the detail in the structured log is what
 * the rest of this codebase already does by hand.
 *
 * `headersSent` is checked because the failure may happen AFTER a partial response (e.g. a
 * stream, or an error in code following `res.json`). Writing a second time would throw
 * ERR_HTTP_HEADERS_SENT and mask the original error.
 */
export function asyncRoute<Req extends Request = Request>(
  handler: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      try {
        await handler(req as Req, res, next);
      } catch (err) {
        logger.error("unhandled error in route handler", {
          // Set by requestObserver; lets the operator find this request's access-log line.
          requestId: (res.locals as { requestId?: string }).requestId,
          method: req.method,
          // The matched route pattern, not the raw URL: `req.originalUrl` can carry a phone
          // number or token in the query string, and this line goes to a log aggregator.
          route: req.route?.path ?? "unknown",
          err: String(err),
        });
        if (res.headersSent) return;
        res.status(500).json({ error: "internal-error" });
      }
    })();
  };
}
