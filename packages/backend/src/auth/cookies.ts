import type { Response } from "express";
import { config } from "../config.js";

/** Auth cookie names. Access is short-lived; refresh is path-scoped so it's only sent to the
 *  refresh endpoint, shrinking its exposure. Both are httpOnly so JS (and XSS) can't read them. */
export const ACCESS_COOKIE = "needy_at";
export const REFRESH_COOKIE = "needy_rt";
const REFRESH_PATH = "/auth/refresh";

function base(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: config.auth.cookieSameSite,
    maxAge: maxAgeSeconds * 1000,
  } as const;
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base(config.auth.accessTtlSeconds), path: "/" });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base(config.auth.refreshTtlDays * 86400),
    path: REFRESH_PATH,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { path: "/" });
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
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
