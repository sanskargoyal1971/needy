import type { NextFunction, RequestHandler, Response } from "express";
import { canTransact, type OnboardingStatus } from "@needy/shared";
import { asyncRoute } from "../http/asyncRoute.js";
import type { AuthedRequest } from "./middleware.js";
import type { UserRepository } from "./repos.js";

/** ── The transaction gate ──────────────────────────────────────────────────
 *  Being signed in is not permission to transact. A user who has submitted their packet can
 *  sign in and look around; they cannot create a task, accept an offer, or open a chat until
 *  a human has approved them.
 *
 *  Why this reads the DATABASE rather than the JWT: the access token carries `role` and is
 *  valid for its full TTL. If onboarding status were a claim, an admin rejecting someone at
 *  10:00 would not take effect until their token expired — the rejected user would keep full
 *  access for the remainder of the window. For a gate whose entire purpose is to stop someone
 *  the moment a reviewer says stop, a stale claim is not an acceptable implementation.
 *
 *  The cost is one indexed primary-key lookup per gated request, which is the right price.
 */

export interface OnboardingGateDeps {
  users: UserRepository;
}

/** Reasons, kept machine-readable so the client can route to the right screen rather than
 *  parsing prose: `under_review` → the waiting screen, `rejected` → the terminal screen,
 *  anything else → back into the wizard. */
export interface GateRefusal {
  error: "onboarding-incomplete";
  onboardingStatus: OnboardingStatus;
  reason: string | null;
}

/**
 * Require an approved account. Chain AFTER `requireAuth`.
 *
 * Fails closed in every direction: no claims → 401; user vanished → 401 (their session
 * outlived their account); not approved → 403 with the status so the UI can redirect.
 */
export function requireOnboarded(deps: OnboardingGateDeps): RequestHandler {
  // Wrapped in asyncRoute for the reason that module documents at length: Express 4 ignores a
  // handler's return value, so a rejection here (a database blip on the user lookup) would
  // otherwise send NO response at all and leave the client hanging until its own timeout. For
  // a gate, that failure mode is worse than usual — the request neither succeeds nor is
  // refused, it just stops.
  return asyncRoute(async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const user = await deps.users.getById(req.user.sub);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (user.blockedAt != null) {
      res.status(403).json({ error: "account-blocked", reason: user.rejectionReason });
      return;
    }
    if (!canTransact(user.onboardingStatus)) {
      const body: GateRefusal = {
        error: "onboarding-incomplete",
        onboardingStatus: user.onboardingStatus,
        reason: user.rejectionReason,
      };
      res.status(403).json(body);
      return;
    }
    next();
  });
}
