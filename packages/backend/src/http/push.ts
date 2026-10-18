import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../auth/middleware.js";
import { validateBody } from "../auth/validation.js";
import type { Deps } from "../domain/deps.js";
import { pushService, pushSubscriptionSchema } from "../services/push.js";
import { asyncRoute } from "./asyncRoute.js";

/** ── Web push registration ─────────────────────────────────────────────────
 *  A browser hands the page a subscription; the page hands it here. Any signed-in person may
 *  register their own device — what they are then SENT is decided by role elsewhere (offers
 *  only ever reach helpers the matcher selected). There is no way to register a device for
 *  someone else: the user id is the caller's, never a parameter.
 */
export function createPushRouter(deps: Deps): Router {
  const router = Router();

  router.get(
    "/push/config",
    requireAuth,
    asyncRoute(async (_req: AuthedRequest, res: Response) => {
      const push = pushService();
      res.json({ enabled: push.enabled, publicKey: push.publicKey });
    }),
  );

  router.post(
    "/me/push-subscription",
    requireAuth,
    validateBody(pushSubscriptionSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const push = pushService();
      if (!push.enabled) {
        res.status(404).json({ error: "push-disabled" });
        return;
      }
      try {
        await push.subscribe(req.user!.sub, req.body as z.infer<typeof pushSubscriptionSchema>);
      } catch {
        res.status(400).json({ error: "invalid-subscription" });
        return;
      }
      res.status(204).end();
    }),
  );

  router.delete(
    "/me/push-subscription",
    requireAuth,
    validateBody(z.object({ endpoint: z.string().url().max(1024) })),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      await pushService().unsubscribe(req.user!.sub, (req.body as { endpoint: string }).endpoint);
      res.status(204).end();
    }),
  );

  deps.logger.debug("push routes mounted", { enabled: pushService().enabled });
  return router;
}
