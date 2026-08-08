import type { Response } from "express";
import { config } from "../config.js";

/** Auth cookie names. Access is short-lived; refresh is path-scoped so it's only sent to the
 *  refresh endpoint, shrinking its exposure. Both are httpOnly so JS (and XSS) can't read them. */
export const ACCESS_COOKIE = "needy_at";
export const REFRESH_COOKIE = "needy_rt";
const REFRESH_PATH = "/auth/refresh";

/** The attribute set that IDENTIFIES a cookie to the browser. A user agent replaces (or
 *  deletes) a stored cookie only when name + Domain + Path match, and it will refuse a
 *  `SameSite=None` Set-Cookie that isn't also `Secure`. Both creation and clearing derive
 *  from this one function so the two can never drift — see `clearAuthCookies`. */
function attributes(path: string) {
  return {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: config.auth.cookieSameSite,
    path,
  } as const;
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...attributes("/"),
    maxAge: config.auth.accessTtlSeconds * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...attributes(REFRESH_PATH),
    maxAge: config.auth.refreshTtlDays * 86400 * 1000,
  });
}

/**
 * Audit C16 — this passed only `{ path }`, dropping `secure`, `sameSite` and `httpOnly`. With
 * COOKIE_SECURE=true / SameSite=None in production that emits a *different* cookie than the one
 * that was set: the browser may keep the original, so "log out" returned 200 while leaving a
 * live session cookie in the browser — the exact failure mode logout exists to prevent. Clear
 * with the EXACT attribute set used at creation (minus maxAge, which express replaces with an
 * `Expires` in the past to force expiry).
 */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, attributes("/"));
  res.clearCookie(REFRESH_COOKIE, attributes(REFRESH_PATH));
}

/** Minimal cookie-header parser (avoids a dependency). Returns a name→value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}
