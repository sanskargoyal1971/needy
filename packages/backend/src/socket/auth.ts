import type { ExtendedError, Socket } from "socket.io";
import { verifyAccessToken, type AuthClaims } from "../auth/jwt.js";
import { ACCESS_COOKIE, parseCookies } from "../auth/cookies.js";

/** Socket.io middleware: authenticate the handshake with the same short-lived JWT used
 *  for REST (§2.1). Reject invalid/expired tokens so the client triggers a silent
 *  re-auth + reconnect. Attaches claims to `socket.data` for every handler downstream. */
export interface SocketData {
  user: AuthClaims;
}

export function authMiddleware(
  socket: Socket,
  next: (err?: ExtendedError) => void,
): void {
  // Prefer the httpOnly access cookie (real auth); fall back to handshake.auth / Bearer
  // header (dev tokens, tests, non-browser clients).
  const cookieToken = parseCookies(socket.handshake.headers.cookie)[ACCESS_COOKIE];
  const token =
    cookieToken ??
    (socket.handshake.auth?.token as string | undefined) ??
    (typeof socket.handshake.headers.authorization === "string"
      ? socket.handshake.headers.authorization.replace(/^Bearer\s+/i, "")
      : undefined);

  if (!token) {
    return next(withCode(new Error("missing auth token"), "AUTH_REQUIRED"));
  }
  const claims = verifyAccessToken(token);
  if (!claims) {
    return next(withCode(new Error("invalid or expired token"), "AUTH_INVALID"));
  }
  (socket.data as SocketData).user = claims;
  next();
}

function withCode(err: Error, code: string): ExtendedError {
  const e = err as ExtendedError;
  e.data = { code };
  return e;
}
