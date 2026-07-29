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

/** True if `held` is allowed to act as `required`. Admin is a superset; "both" covers
 *  requester and helper; otherwise an exact match. */
export function satisfiesRole(held: Role, required: Role): boolean {
  if (held === "admin") return true;
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
