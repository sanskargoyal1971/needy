import type { NextFunction, Request, Response } from "express";
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
