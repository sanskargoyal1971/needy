import type { ExtendedError, Socket } from "socket.io";
import { canTransact } from "@needy/shared";
import type { UserRepository } from "../auth/repos.js";
import { logger } from "../logger.js";
import type { SocketData } from "./auth.js";

/** ── The transaction gate, socket edition ──────────────────────────────────
 *  The HTTP gate on `POST /tasks` is only half the surface. Accepting an offer, sending a
 *  chat message and publishing a location all happen over Socket.io, never through Express —
 *  so gating only the REST route would leave an unapproved helper able to accept work by
 *  connecting to `/matching` directly. That is the same hole as an unprotected API, reached
 *  by a different door.
 *
 *  Applied as connection middleware rather than per-event: it is one lookup at handshake
 *  instead of one per message, and refusing the connection outright gives the client a clear
 *  signal to route the user to the hold screen rather than silently dropping their actions.
 *
 *  The trade this makes: a user approved *during* a live connection keeps a connection that
 *  was refused, and a user rejected during one keeps a connection that was allowed, until
 *  they reconnect. Approval is a human action minutes-to-hours in the making, so the first
 *  case is a non-issue. The second matters more, and is handled where it counts — the HTTP
 *  gate re-checks on every request, and `blockedAt` is checked here too, so a blocked user is
 *  out on their next reconnect (which a token refresh forces within 15 minutes).
 */
export function createSocketOnboardingGate(
  users: UserRepository,
): (socket: Socket, next: (err?: ExtendedError) => void) => void {
  // Returns void, not a Promise. Socket.io's middleware signature is synchronous — it calls
  // the function and ignores the return value — so an `async` middleware that rejects produces
  // an unhandled rejection and, worse, never calls `next` in either direction: the handshake
  // just hangs. The `void (async () => …)()` shape keeps the async body while guaranteeing
  // every path reaches `next`, which is the same reasoning as http/asyncRoute.ts.
  return (socket, next) => {
    void (async () => {
      const claims = (socket.data as SocketData).user;
      if (!claims) {
        // authMiddleware runs first and should have rejected already; if it somehow did not,
        // fail closed rather than treating an unauthenticated socket as approved.
        next(withCode(new Error("not authenticated"), "AUTH_REQUIRED"));
        return;
      }
      try {
        const user = await users.getById(claims.sub);
        if (!user) {
          next(withCode(new Error("unknown account"), "AUTH_INVALID"));
          return;
        }
        if (user.blockedAt != null) {
          next(withCode(new Error("account blocked"), "ACCOUNT_BLOCKED"));
          return;
        }
        if (!canTransact(user.onboardingStatus)) {
          next(withCode(new Error("verification incomplete"), "ONBOARDING_INCOMPLETE"));
          return;
        }
        next();
      } catch (err) {
        // A database blip must not become "connection allowed". Fail closed and log — the
        // client retries, and the alternative is an outage that silently disables the gate.
        logger.error("socket onboarding gate failed", { err: String(err) });
        next(withCode(new Error("temporarily unavailable"), "GATE_UNAVAILABLE"));
      }
    })();
  };
}

function withCode(err: Error, code: string): ExtendedError {
  const e = err as ExtendedError;
  e.data = { code };
  return e;
}
