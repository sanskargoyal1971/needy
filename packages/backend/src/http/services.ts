import { Router, type Response } from "express";
import { z } from "zod";
import { MANDATORY_SERVICE_CODES } from "@needy/shared";
import { requireAuth, type AuthedRequest } from "../auth/middleware.js";
import { requireOnboarded } from "../auth/onboardingGate.js";
import { validateBody } from "../auth/validation.js";
import type { Deps } from "../domain/deps.js";
import { asyncRoute } from "./asyncRoute.js";

/** ── The service catalog, over HTTP ────────────────────────────────────────
 *  Three routes that did not exist, which is why `/helper/services` had neither a page nor an
 *  API: `setHelperServices` was reachable ONLY from the admin approval path, where it enrols a
 *  new helper in the mandatory set. A helper could therefore never say what else they do, so
 *  every helper on the platform offered exactly one service — hospital — and the matching
 *  service filter had nothing else to match on. The catalog, the filter and the enrolment were
 *  all built; the one thing missing was any way for the person to answer the question.
 */

const selectionSchema = z.object({
  /** Bounded so one request cannot ask us to write an unbounded number of rows. The catalog is
   *  small; a helper legitimately offering more than fifty services does not exist. */
  codes: z.array(z.string().trim().min(1).max(64)).max(50),
});

export function createServicesRouter(deps: Deps): Router {
  const router = Router();

  // ── the catalog ────────────────────────────────────────────────────────────
  //
  // Authenticated but NOT gated on onboarding: a half-onboarded user is exactly who needs to
  // see what the platform does. It is a menu, not anyone's data.
  router.get(
    "/services",
    requireAuth,
    asyncRoute(async (_req: AuthedRequest, res: Response) => {
      res.json({ services: await deps.services.list() });
    }),
  );

  // ── what I offer ───────────────────────────────────────────────────────────
  router.get(
    "/me/services",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      res.json({
        codes: await deps.services.forHelper(req.user!.sub),
        // Sent so the UI can render these as locked rather than as unchecked boxes the user
        // will try to untick. The rule is enforced on write regardless — this only lets the
        // interface tell the truth about it in advance.
        mandatory: MANDATORY_SERVICE_CODES,
      });
    }),
  );

  // ── choose what I offer ────────────────────────────────────────────────────
  router.put(
    "/me/services",
    requireAuth,
    // Transacting, so an unapproved account may not. Same gate as task creation.
    requireOnboarded({ users: deps.users }),
    validateBody(selectionSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const userId = req.user!.sub;
      const user = await deps.users.getById(userId);
      // A requester has nothing to offer. Refused rather than silently stored, because a row
      // in `helper_services` for a non-helper would make them a matching candidate whose
      // eligibility depends entirely on a role check elsewhere holding.
      if (!user || (user.role !== "helper" && user.role !== "both")) {
        res.status(403).json({ error: "not-a-helper" });
        return;
      }

      const { codes } = req.body as z.infer<typeof selectionSchema>;
      // `setHelperServices` unions in the mandatory codes and drops anything not in the
      // catalog, so there is no request shape that opts out of the emergency pool or invents
      // a service. The returned list is the truth, not the request.
      const saved = await deps.services.setHelperServices(userId, codes, deps.now());
      deps.logger.info("helper services updated", { userId, count: saved.length });
      res.json({ codes: saved, mandatory: MANDATORY_SERVICE_CODES });
    }),
  );

  return router;
}
