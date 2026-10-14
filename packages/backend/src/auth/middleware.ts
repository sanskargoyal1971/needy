import type { NextFunction, Request, RequestHandler, Response } from "express";
import { verifyAccessToken, type AuthClaims } from "./jwt.js";
import { ACCESS_COOKIE, parseCookies } from "./cookies.js";
import type { Role } from "./types.js";

/** Request augmented with the authenticated principal by `requireAuth`. */
export interface AuthedRequest extends Request {
  user?: AuthClaims;
}

/** Resolve access claims from the httpOnly cookie first, then a Bearer header (dev/tests/the
 *  socket handshake path). Returns null when neither yields valid claims. */
export function readAccessClaims(req: Request): AuthClaims | null {
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = cookies[ACCESS_COOKIE];
  if (fromCookie) {
    const claims = verifyAccessToken(fromCookie);
    if (claims) return claims;
  }
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const claims = verifyAccessToken(header.replace(/^Bearer\s+/i, ""));
    if (claims) return claims;
  }
  return null;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const claims = readAccessClaims(req);
  if (!claims) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.user = claims;
  next();
}

/** True if `held` is allowed to act as `required`.
 *
 *  `super_admin` satisfies everything, including `admin` — it is strictly above it, so every
 *  admin surface is reachable without duplicating a guard on each route. `admin` satisfies
 *  everything EXCEPT `super_admin`: staff administration is the one thing an ordinary admin
 *  may not reach, which is what stops an admin minting another admin. */
export function satisfiesRole(held: Role, required: Role): boolean {
  if (held === "super_admin") return true;
  if (held === "admin") return required !== "super_admin";
  if (held === required) return true;
  if (held === "both" && (required === "requester" || required === "helper")) return true;
  return false;
}

/** Enforce a role at the API layer (never trust the UI). Must be chained after requireAuth. */
export function requireRole(required: Role) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!satisfiesRole(req.user.role, required)) {
      res.status(403).json({ error: "forbidden", required });
      return;
    }
    next();
  };
}

/**
 * Was this access token minted under the account's current session epoch?
 *
 * False once every session on the account has been ended for cause (a second factor added or
 * removed, a password changed): the refresh sessions are revoked at that moment, and this is
 * what makes the access tokens they had already handed out stop too, instead of running out
 * their lifetime. Only usable where the user row has been loaded anyway.
 */
export function accessTokenIsCurrent(
  claims: Pick<AuthClaims, "epoch">,
  user: { sessionEpoch: number },
): boolean {
  return (claims.epoch ?? 0) === user.sessionEpoch;
}

/**
 * Require a member of staff, decided by the DATABASE.
 *
 * `requireRole` reads the role out of the access token, which stays valid for its whole
 * lifetime. For participant routes that is a small window on a small privilege. For the admin
 * surface it meant an operator who had just been demoted or deactivated kept the verification
 * console — every applicant's ID, the SOS feed — until their token happened to expire. Staff
 * authority is the one thing that must be withdrawn the moment someone withdraws it, so it is
 * read from the row each time. One primary-key lookup per admin request.
 *
 * The same lookup also checks the token's session epoch, so a device whose session was ended
 * — the lost phone someone just removed as their authenticator — loses the console at once.
 *
 * Chain AFTER `requireAuth`. Fails closed: no account, a blocked account, a token from before
 * the account's sessions were ended, or a role below `required` are all refused.
 */
export function requireStaff(
  users: {
    getById(
      id: string,
    ): Promise<{ role: Role; blockedAt: number | null; sessionEpoch: number } | null>;
  },
  required: "admin" | "super_admin" = "admin",
): RequestHandler {
  return (req, res, next) => {
    const claims = (req as AuthedRequest).user;
    if (!claims) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    users
      .getById(claims.sub)
      .then((user) => {
        if (!user || user.blockedAt != null) {
          res.status(401).json({ error: "unauthorized" });
          return;
        }
        const isStaff = user.role === "admin" || user.role === "super_admin";
        if (!isStaff || !satisfiesRole(user.role, required)) {
          res.status(403).json({ error: "forbidden", required });
          return;
        }
        // 401, not 403: the token is stale, and the client's answer to that is to refresh —
        // which fails too if the session was ended, and lands them at sign-in.
        if (!accessTokenIsCurrent(claims, user)) {
          res.status(401).json({ error: "unauthorized" });
          return;
        }
        // Downstream handlers read the role from here; make it the current one.
        claims.role = user.role;
        next();
      })
      .catch(next);
  };
}
