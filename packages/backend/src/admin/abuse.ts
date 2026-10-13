import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ABUSE_WINDOW_MS, type AbuseRollup } from "@needy/shared";
import { requireAuth, requireStaff, type AuthedRequest } from "../auth/middleware.js";
import { validateBody } from "../auth/validation.js";
import type { Deps } from "../domain/deps.js";
import { asyncRoute } from "../http/asyncRoute.js";
import { maskPhone } from "./verificationRepo.js";

/** ── Abuse review queue ────────────────────────────────────────────────────
 *  Signals in, human judgement out. Nothing in this file blocks, suspends or restricts
 *  anybody: it ranks accounts by accumulated signal weight so an operator knows where to
 *  look, and every consequence still runs through the existing block route with its own
 *  audit trail.
 *
 *  That separation is the design, not an omission. The strongest signals here — a burned
 *  handoff code, a run of cancellations — are all *ambiguous*. A helper who fails the code at
 *  the door is either an impostor or someone standing outside a flat whose occupant has put
 *  their phone down. Automating the response would mean choosing, in advance and without
 *  context, to sometimes lock out the second person; and on a platform whose users are
 *  elderly, the cost of wrongly cutting someone off from help is not symmetric with the cost
 *  of an operator reading one more row.
 *
 *  Marking a subject reviewed writes an `abuse.reviewed` audit row and does NOT delete their
 *  signals — the observations stay, the judgement sits beside them.
 */

const reviewSchema = z.object({
  /** What the operator concluded. Free text because the useful thing to record here — "spoke
   *  to her, the helper had the wrong building" — does not fit a fixed set of reasons. */
  note: z.string().trim().min(1).max(1000),
  /** Their read on it. Kept coarse so the audit log can be filtered later. */
  outcome: z.enum(["no-action", "warned", "escalated"]),
});

export function createAbuseRouter(deps: Deps): Router {
  const router = Router();
  const adminOnly = [requireAuth, requireStaff(deps.users, "admin")] as const;
  const ip = (req: Request) => req.ip ?? req.socket?.remoteAddress ?? null;

  // ── the queue ──────────────────────────────────────────────────────────────
  router.get(
    "/admin/abuse",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const windowMs = Math.min(
        Math.max(Number(req.query.windowMs ?? ABUSE_WINDOW_MS) || ABUSE_WINDOW_MS, 60_000),
        // A year. Past that the query stops being a review queue and becomes an export.
        365 * 24 * 60 * 60 * 1000,
      );
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      const since = deps.now() - windowMs;

      const tallies = await deps.abuse.tally({ since, limit });

      // Identity is joined here rather than in SQL so the in-memory and Postgres stores stay
      // behaviourally identical, and so masking happens in exactly one place. Concurrent, and
      // bounded by `limit`.
      const entries: AbuseRollup[] = (
        await Promise.all(
          tallies.map(async (t) => {
            const user = await deps.users.getById(t.subjectId);
            return {
              subjectId: t.subjectId,
              // An account can be deleted while its signals survive (there is no FK — see
              // migration 5). Showing the id rather than dropping the row is the honest
              // rendering: the behaviour happened even if the account is gone.
              displayName: user?.displayName ?? "(deleted account)",
              phoneMasked: user ? maskPhone(user.phone) : "***",
              role: user?.role ?? "unknown",
              blockedAt: user?.blockedAt ?? null,
              score: t.score,
              total: t.total,
              byKind: t.byKind,
              firstAt: t.firstAt,
              lastAt: t.lastAt,
            };
          }),
        )
      ).filter((e): e is AbuseRollup => e != null);

      res.json({ entries, windowMs, since });
    }),
  );

  // ── one subject's actual observations ──────────────────────────────────────
  router.get(
    "/admin/abuse/:userId",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const windowMs = Math.min(
        Math.max(Number(req.query.windowMs ?? ABUSE_WINDOW_MS) || ABUSE_WINDOW_MS, 60_000),
        365 * 24 * 60 * 60 * 1000,
      );
      const since = deps.now() - windowMs;
      const [user, signals] = await Promise.all([
        deps.users.getById(req.params.userId),
        deps.abuse.listForSubject(req.params.userId, since, 200),
      ]);

      res.json({
        // Full phone here, masked in the list above: this is one account an operator has
        // deliberately opened in order to act on it, which is the same distinction the
        // verification console draws between its queue and a packet.
        user: user
          ? {
              id: user.id,
              displayName: user.displayName,
              phone: user.phone,
              role: user.role,
              onboardingStatus: user.onboardingStatus,
              blockedAt: user.blockedAt,
              createdAt: user.createdAt,
            }
          : null,
        signals,
        windowMs,
      });
    }),
  );

  // ── record a judgement ─────────────────────────────────────────────────────
  //
  // No repository write: the audit log IS the record. A `reviewed_at` column on the signals
  // would mean mutating an append-only table, and a separate "reviews" table would duplicate
  // what audit_log already stores immutably and queries by subject.
  router.post(
    "/admin/abuse/:userId/review",
    ...adminOnly,
    validateBody(reviewSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const body = req.body as z.infer<typeof reviewSchema>;
      const user = await deps.users.getById(req.params.userId);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }
      await deps.audit.record({
        action: "abuse.reviewed",
        actorId: req.user!.sub,
        actorRole: "admin",
        subjectType: "user",
        subjectId: user.id,
        metadata: { outcome: body.outcome, note: body.note },
        ip: ip(req),
      });
      // `escalated` is a note to other operators, not an action: blocking is a separate,
      // deliberate POST to /admin/users/:id/block with its own reason and its own audit row.
      res.json({ ok: true, outcome: body.outcome });
    }),
  );

  return router;
}
