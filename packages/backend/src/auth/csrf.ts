import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ACCESS_COOKIE, parseCookies } from "./cookies.js";

/** ── CSRF ──────────────────────────────────────────────────────────────────
 *  AGENTS.md requires it and there was none: `grep -ri csrf` over the whole repo returned
 *  nothing. The only thing standing between a cross-site POST and a state change was
 *  `SameSite=strict` on the auth cookies — real protection, but a single env var
 *  (`COOKIE_SAMESITE=none`, which a cross-site deployment would legitimately want) silently
 *  removes it, and there was no second lock behind it.
 *
 *  Two independent checks, in this order:
 *
 *   1. **Origin.** A browser sets `Origin` on every cross-origin request and cannot be talked
 *      out of it from script. A mutating request whose Origin is not on the allowlist is
 *      refused outright. This is the structural check and it is the one that actually stops
 *      the attack.
 *   2. **A token the attacker cannot obtain.** Minted per session, stored in a cookie AND
 *      returned in a JSON body, and required back in the `X-CSRF-Token` header.
 *
 *  Why the token is fetched from a body rather than read out of the cookie, which is how the
 *  double-submit pattern is usually described: the SPA and the API are different origins
 *  (`:3000` and `:4000` in dev, `web.` and `api.` in production), so `document.cookie` on the
 *  page cannot see a cookie the API set. The client therefore reads the token from
 *  `GET /auth/csrf`'s response body — which an attacker's page cannot do, because CORS will
 *  not let it read a cross-origin response body from an origin that is not on the allowlist.
 *  The cookie half is still what binds the token to the browser session, so a token lifted
 *  from one user cannot be replayed by another.
 *
 *  Scope: the token is required only when the request authenticates by COOKIE. CSRF is an
 *  attack on ambient authority — a caller presenting `Authorization: Bearer` had to obtain
 *  that token and set a header, neither of which a cross-site form can do. Demanding a CSRF
 *  token from bearer clients would break every non-browser caller for no security gain.
 */

export const CSRF_COOKIE = "needy_csrf";
export const CSRF_HEADER = "x-csrf-token";

/** Read-only verbs never mutate, so they are never the target of this attack. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Same attributes as the auth cookies EXCEPT httpOnly, which would defeat the purpose — but
 *  note the token is not secret in the way a session is: it is worthless without also being
 *  able to make the browser send the session cookie, and it is only ever handed to an origin
 *  CORS already trusts. */
function csrfCookieAttributes() {
  return {
    httpOnly: false,
    secure: config.auth.cookieSecure,
    sameSite: config.auth.cookieSameSite,
    path: "/",
  } as const;
}

/** Mint a fresh token and set it. Returned so the caller can put it in a response body. */
export function issueCsrfToken(res: Response): string {
  const token = randomBytes(32).toString("base64url");
  res.cookie(CSRF_COOKIE, token, {
    ...csrfCookieAttributes(),
    // Comfortably longer than an access token so an idle tab does not have to re-fetch on
    // every action, and short enough that a token is not indefinitely valid.
    maxAge: config.auth.refreshTtlDays * 86400 * 1000,
  });
  return token;
}

/** Constant-time compare of two tokens of possibly different length. */
function tokensMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // `timingSafeEqual` throws on a length mismatch, which would itself leak length through the
  // exception path, so the lengths are compared first and the result folded in.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** The set of origins allowed to make mutating requests.
 *
 *  Read straight off `config.corsOrigins`, which is the SAME array handed to the CORS layer.
 *  Parsing the env var a second time here is how the two lists end up disagreeing — and the
 *  direction they would disagree in is the dangerous one, since a CSRF check that trusts an
 *  origin CORS does not is a check with a hole in it. */
function allowedOrigins(): readonly string[] {
  return config.corsOrigins;
}

/** Normalise a URL to its origin, or null if it is not parseable. `Referer` is a full URL;
 *  `Origin` is already just an origin, and passing one through `new URL` is harmless. */
function originOf(value: string | undefined): string | null {
  if (!value || value === "null") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export interface CsrfOptions {
  /**
   * Paths exempt from BOTH checks.
   *
   * Exactly one thing belongs here: the KYC provider callback. It is a server-to-server POST
   * that authenticates with an HMAC over the raw request body, carries no cookie, and comes
   * from an origin we do not control and cannot enumerate. Applying an Origin allowlist to it
   * would reject every legitimate callback.
   */
  exemptPaths?: readonly string[];
}

export function csrfProtection(opts: CsrfOptions = {}) {
  const exempt = opts.exemptPaths ?? [];

  return function csrf(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) return next();
    if (exempt.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();

    // ── 1. Origin ────────────────────────────────────────────────────────────
    const claimed =
      originOf(req.headers.origin as string | undefined) ??
      originOf(req.headers.referer as string | undefined);

    if (claimed != null && !allowedOrigins().includes(claimed)) {
      logger.warn("refused a mutating request from an unrecognised origin", {
        path: req.path,
        origin: claimed,
      });
      res.status(403).json({ error: "bad-origin" });
      return;
    }
    // A request with NEITHER header is not a browser form post — browsers always attach at
    // least one to a cross-origin mutation. It is curl, a test, or a native client, and those
    // are handled by the bearer rule below rather than by guessing from missing headers.

    // ── 2. The token, for cookie-authenticated requests only ─────────────────
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies[ACCESS_COOKIE]) return next();

    if (!tokensMatch(req.headers[CSRF_HEADER] as string | undefined, cookies[CSRF_COOKIE])) {
      logger.warn("refused a cookie-authenticated request with no valid CSRF token", {
        path: req.path,
        hadHeader: Boolean(req.headers[CSRF_HEADER]),
        hadCookie: Boolean(cookies[CSRF_COOKIE]),
      });
      // A distinct code, not a generic 403: the client's correct response is to re-fetch the
      // token and retry once, and it can only do that if it can tell this apart from "you are
      // not allowed to do this at all".
      res.status(403).json({ error: "csrf-invalid" });
      return;
    }

    next();
  };
}
