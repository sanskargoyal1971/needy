import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  DOCUMENT_LABELS,
  isOnboardingStatus,
  REQUIRED_DOCUMENTS,
} from "@needy/shared";
import type { AuditLogger } from "../audit/log.js";
import { readAuditLog } from "../audit/log.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import type { PhoneBlockRepository } from "../auth/phoneBlocks.js";
import type { SessionRepository, UserRepository } from "../auth/repos.js";
import type { User } from "../auth/types.js";
import { adminSetPasswordSchema, validateBody } from "../auth/validation.js";
import { passwordProblem, PASSWORD_MIN_LENGTH } from "../auth/password.js";
import type { AuthService } from "../auth/service.js";
import { config } from "../config.js";
import type { DbPool } from "../db.js";
import { asyncRoute } from "../http/asyncRoute.js";
import { logger } from "../logger.js";
import type { KycDocumentRepository } from "../onboarding/repos.js";
import { verifyLocalSignature, type StorageProvider } from "../services/storage.js";
import type { ServiceCatalog } from "../services/catalog.js";
import type { AdminUserQueries } from "./verificationRepo.js";

/** ── Admin verification surface ────────────────────────────────────────────
 *  The human review this whole platform's trust model rests on: an operator looks at a
 *  government ID, a live selfie and a spoken testimony, and decides.
 *
 *  Two principles run through every handler:
 *
 *   1. **Looking is an action.** Opening someone's packet mints short-lived signed URLs and
 *      writes an `admin.document_viewed` row per document. "Which of our staff looked at this
 *      person's Aadhaar, and when" must be answerable, and it is not answerable after the
 *      fact if nobody wrote it down at the time.
 *   2. **Rejection is terminal and must actually bite.** It sets the status, blocks the phone
 *      so re-registering is not a way around the decision, and revokes every session so the
 *      rejected user cannot keep using a token minted before the decision.
 */

export interface VerificationRouterDeps {
  users: UserRepository;
  sessions: SessionRepository;
  documents: KycDocumentRepository;
  phoneBlocks: PhoneBlockRepository;
  queries: AdminUserQueries;
  /** Used on approval to enrol a new helper in the mandatory services. */
  services: ServiceCatalog;
  storage: StorageProvider;
  audit: AuditLogger;
  /** Owns password hashing and session revocation, so the admin override goes through exactly
   *  the same path the account holder does rather than writing a hash of its own. */
  auth: AuthService;
  pool: DbPool | null;
  now: () => number;
}

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  /** Shown to the applicant on the terminal screen when rejecting, so it must be written for
   *  them, not for internal notes. Required on reject: "no" without a reason is not a review. */
  reason: z.string().trim().min(1).max(500).optional(),
  /** Optional role grant on approval — this is how an applicant is onboarded as a helper.
   *  "admin" is absent by design: no admin may mint another admin through the review flow. */
  role: z.enum(["requester", "helper", "both"]).optional(),
});

const blockSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  /** Also refuse the phone number for future registrations. Separate from the account block
   *  because "this account is suspended" and "this person may not hold an account" are
   *  genuinely different decisions with different reversibility. */
  blockPhone: z.boolean().optional(),
});

/** Everything an operator needs to make the call, and nothing they don't. Note the FULL phone
 *  number is present here where the queue's is masked: a reviewer comparing an ID against an
 *  account legitimately needs it, and this endpoint is one packet at a time rather than a
 *  list — which is the difference between a lookup and a directory. */
function packetView(user: User) {
  return {
    id: user.id,
    displayName: user.displayName,
    phone: user.phone,
    email: user.email,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    areaLabel: user.areaLabel,
    role: user.role,
    onboardingStatus: user.onboardingStatus,
    kycStatus: user.kycStatus,
    submittedAt: user.submittedAt,
    createdAt: user.createdAt,
    reviewedBy: user.reviewedBy,
    reviewedAt: user.reviewedAt,
    rejectionReason: user.rejectionReason,
    blockedAt: user.blockedAt,
  };
}

export function createVerificationRouter(deps: VerificationRouterDeps): Router {
  const router = Router();
  const adminOnly = [requireAuth, requireRole("admin")] as const;
  const ip = (req: Request) => req.ip ?? req.socket?.remoteAddress ?? null;

  // ── the review queue ───────────────────────────────────────────────────────
  router.get(
    "/admin/verifications",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const raw = String(req.query.status ?? "under_review");
      if (!isOnboardingStatus(raw)) {
        res.status(400).json({ error: "unknown-status" });
        return;
      }
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      const [entries, counts] = await Promise.all([
        deps.queries.queue(raw, limit),
        deps.queries.counts(),
      ]);
      res.json({ entries, counts });
    }),
  );

  // ── one packet, with viewable documents ────────────────────────────────────
  router.get(
    "/admin/verifications/:userId",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const user = await deps.users.getById(req.params.userId);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }
      const docs = await deps.documents.listForUser(user.id);

      // Signed, short-lived, minted per view. Nothing durable is handed out: the stored row
      // holds an opaque key, and a URL only exists for the ~2 minutes an operator is looking.
      const documents = await Promise.all(
        docs.map(async (d) => ({
          kind: d.kind,
          label: DOCUMENT_LABELS[d.kind].title,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
          uploadedAt: d.createdAt,
          url: await deps.storage.signedUrl(d.storageKey, config.storage.signedUrlTtlSeconds),
          // Same bytes submitted by another account. One of the clearer fraud signals
          // available without any external provider — the same ID scan doing the rounds.
          alsoSubmittedBy: await deps.documents.findOtherUsersWithDigest(d.sha256, user.id),
        })),
      );

      // One row per document, because access was granted to each. Written before the response
      // so a crash between the two cannot produce an unlogged view.
      await Promise.all(
        documents.map((d) =>
          deps.audit.record({
            action: "admin.document_viewed",
            actorId: req.user!.sub,
            actorRole: "admin",
            subjectType: "user",
            subjectId: user.id,
            metadata: { kind: d.kind },
            ip: ip(req),
          }),
        ),
      );

      res.json({
        user: packetView(user),
        documents,
        missing: REQUIRED_DOCUMENTS.filter((k) => !docs.some((d) => d.kind === k)),
      });
    }),
  );

  // ── approve / reject ───────────────────────────────────────────────────────
  router.post(
    "/admin/verifications/:userId/decision",
    ...adminOnly,
    validateBody(decisionSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const adminId = req.user!.sub;
      const body = req.body as z.infer<typeof decisionSchema>;
      const user = await deps.users.getById(req.params.userId);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }

      // Only a submitted packet is decidable. Approving someone who never uploaded anything
      // would hand out verified status for an empty review, and re-deciding a settled case
      // silently overwrites the first reviewer's call.
      if (user.onboardingStatus !== "under_review") {
        res.status(409).json({
          error: "not-awaiting-review",
          onboardingStatus: user.onboardingStatus,
        });
        return;
      }

      // An admin cannot decide their own packet. Self-approval is the one review that is
      // guaranteed not to be independent.
      if (adminId === user.id) {
        res.status(403).json({ error: "cannot-review-own-account" });
        return;
      }

      if (body.decision === "reject" && !body.reason) {
        res.status(422).json({ error: "reason-required-to-reject" });
        return;
      }

      const now = deps.now();

      if (body.decision === "approve") {
        // The documents are re-checked here rather than trusted from the queue: a packet can
        // only reach `under_review` complete, but this is the irreversible grant, and it is
        // cheap to confirm the thing being approved still exists.
        const docs = await deps.documents.listForUser(user.id);
        const missing = REQUIRED_DOCUMENTS.filter((k) => !docs.some((d) => d.kind === k));
        if (missing.length > 0) {
          res.status(422).json({ error: "documents-incomplete", missing });
          return;
        }

        const updated = await deps.users.update(user.id, {
          onboardingStatus: "approved",
          kycStatus: "verified",
          role: body.role ?? user.role,
          reviewedBy: adminId,
          reviewedAt: now,
          rejectionReason: null,
          updatedAt: now,
        });

        await deps.audit.record({
          action: "onboarding.approved",
          actorId: adminId,
          actorRole: "admin",
          subjectType: "user",
          subjectId: user.id,
          metadata: { role: updated.role, note: body.reason ?? null },
          ip: ip(req),
        });

        // ── enrol a new helper in the mandatory services ────────────────────
        //
        // Migration 4 backfilled the helpers that already existed, but nothing enrolled the
        // ones approved AFTER it ran — so every helper onboarded from here on would have had
        // an empty service list and been filtered out of every offer, including the hospital
        // pool the whole platform treats as the emergency path. Found by walking the flow end
        // to end and finding three freshly-approved helpers enrolled in nothing.
        //
        // `setHelperServices([])` is the right call rather than an explicit list: it unions in
        // MANDATORY_SERVICE_CODES itself, so this stays correct if the mandatory set changes.
        // Their optional services are theirs to pick afterwards.
        if (updated.role === "helper" || updated.role === "both") {
          await deps.services.setHelperServices(updated.id, [], now).catch((err: unknown) =>
            logger.error("helper not enrolled in mandatory services on approval", {
              userId: updated.id,
              err: String(err),
            }),
          );
        }

        // A helper needs a row in `helpers` for the matching reveal card to have anything to
        // render. Best-effort: a missing profile row degrades the reveal, it does not
        // invalidate the approval, so it must not roll the decision back.
        if (deps.pool && (updated.role === "helper" || updated.role === "both")) {
          await deps.pool
            .query(
              `INSERT INTO helpers (id, display_name, photo_url, bio, rating, helped_count, total_earnings)
               VALUES ($1, $2, '', '', 0, 0, 0)
               ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
              [updated.id, updated.displayName],
            )
            .catch((err: unknown) =>
              logger.error("helper profile row not created on approval", {
                userId: updated.id,
                err: String(err),
              }),
            );
        }

        res.json({ user: packetView(updated) });
        return;
      }

      // ── reject ───────────────────────────────────────────────────────────
      const updated = await deps.users.update(user.id, {
        onboardingStatus: "rejected",
        kycStatus: "rejected",
        rejectionReason: body.reason!,
        reviewedBy: adminId,
        reviewedAt: now,
        updatedAt: now,
      });

      // Block the NUMBER, not just the account. Without this, rejection is a speed bump:
      // sign up again on the same phone and you are back at the front of the funnel.
      await deps.phoneBlocks.block(user.phone, body.reason!, adminId, now);

      // Revoke every session. `requireOnboarded` reads the database so the rejected user is
      // already refused on their next request, but their refresh token would otherwise keep
      // minting fresh access tokens indefinitely — the block has to reach the credential too.
      await deps.sessions.revokeAllForUser(user.id, now);

      await deps.audit.record({
        action: "onboarding.rejected",
        actorId: adminId,
        actorRole: "admin",
        subjectType: "user",
        subjectId: user.id,
        // The reason is recorded: it is shown to the applicant, so it is already disclosed,
        // and a rejection whose stated reason cannot be recovered later is not reviewable.
        metadata: { reason: body.reason, phoneBlocked: true },
        ip: ip(req),
      });

      res.json({ user: packetView(updated) });
    }),
  );

  // ── block / unblock an existing account ────────────────────────────────────
  router.post(
    "/admin/users/:userId/block",
    ...adminOnly,
    validateBody(blockSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const adminId = req.user!.sub;
      const body = req.body as z.infer<typeof blockSchema>;
      const user = await deps.users.getById(req.params.userId);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }
      if (user.id === adminId) {
        res.status(403).json({ error: "cannot-block-self" });
        return;
      }
      // Staff are administered from the super admin's surface, not from here. Without this an
      // ordinary admin could block a colleague — or the super admin — and lock the rest of the
      // team out of the console mid-incident, which is a far larger power than "review this
      // applicant" was ever meant to carry.
      if (user.role === "admin" || user.role === "super_admin") {
        res.status(403).json({ error: "staff-account", hint: "use the staff surface" });
        return;
      }
      const now = deps.now();
      const updated = await deps.users.update(user.id, {
        blockedAt: now,
        rejectionReason: body.reason,
        updatedAt: now,
      });
      if (body.blockPhone) await deps.phoneBlocks.block(user.phone, body.reason, adminId, now);
      await deps.sessions.revokeAllForUser(user.id, now);

      await deps.audit.record({
        action: "admin.user_blocked",
        actorId: adminId,
        actorRole: "admin",
        subjectType: "user",
        subjectId: user.id,
        metadata: { reason: body.reason, phoneBlocked: Boolean(body.blockPhone) },
        ip: ip(req),
      });
      res.json({ user: packetView(updated) });
    }),
  );

  // ── issue a temporary password ─────────────────────────────────────────────
  //
  // The last way back in for someone who has lost the number entirely — no handset, no SIM, so
  // no one-time code and no self-service reset. It is deliberately the narrowest of the three
  // routes and the loudest: staff can hand out a credential to an account that is not theirs,
  // which is real power over a real person, so every use is audited with the admin's name
  // against it and every existing session on that account is revoked.
  //
  // NOT usable on another admin. An operator who could reset a colleague's password could take
  // over the console that sees every emergency — and the second factor would not stop them,
  // because they would then hold the password and could ask for the code themselves.
  router.post(
    "/admin/users/:userId/password",
    ...adminOnly,
    validateBody(adminSetPasswordSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const adminId = req.user!.sub;
      const { newPassword } = req.body as z.infer<typeof adminSetPasswordSchema>;
      const user = await deps.users.getById(req.params.userId);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }
      if (user.role === "admin") {
        res.status(403).json({ error: "cannot-set-admin-password" });
        return;
      }
      const problem = passwordProblem(newPassword, user.phone);
      if (problem) {
        res.status(422).json({ error: "weak-password", problem, minLength: PASSWORD_MIN_LENGTH });
        return;
      }

      await deps.auth.setPassword(user.id, newPassword, { setBy: adminId });

      await deps.audit.record({
        action: "admin.password_set",
        actorId: adminId,
        actorRole: "admin",
        subjectType: "user",
        subjectId: user.id,
        // The password itself is never recorded, here or anywhere. What matters after the fact
        // is that staff issued one and when — not what it was.
        metadata: { sessionsRevoked: true },
        ip: ip(req),
      });
      logger.warn("admin issued a temporary password", { adminId, userId: user.id });
      res.json({ ok: true });
    }),
  );

  router.post(
    "/admin/users/:userId/unblock",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const adminId = req.user!.sub;
      const user = await deps.users.getById(req.params.userId);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }
      const now = deps.now();
      const updated = await deps.users.update(user.id, {
        blockedAt: null,
        rejectionReason: null,
        updatedAt: now,
      });
      // Lifting the account block lifts the phone block too — leaving the number blocked
      // would silently keep them out on next sign-in and look like the unblock failed.
      await deps.phoneBlocks.unblock(user.phone);

      await deps.audit.record({
        action: "admin.user_unblocked",
        actorId: adminId,
        actorRole: "admin",
        subjectType: "user",
        subjectId: user.id,
        ip: ip(req),
      });
      res.json({ user: packetView(updated) });
    }),
  );

  // ── directory ──────────────────────────────────────────────────────────────
  router.get(
    "/admin/users",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const search = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : undefined;
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      res.json({ users: await deps.queries.listUsers({ search, limit }) });
    }),
  );

  // ── audit log ──────────────────────────────────────────────────────────────
  router.get(
    "/admin/audit",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      if (!deps.pool) {
        // Honest about it rather than returning [] — an empty audit log and an audit log that
        // was never durable look identical to a reviewer, and only one of them is fine.
        res.json({ entries: [], durable: false });
        return;
      }
      const entries = await readAuditLog(deps.pool, {
        subjectType: typeof req.query.subjectType === "string" ? req.query.subjectType : undefined,
        subjectId: typeof req.query.subjectId === "string" ? req.query.subjectId : undefined,
        actorId: typeof req.query.actorId === "string" ? req.query.actorId : undefined,
        limit: Number(req.query.limit ?? 100) || 100,
      });
      res.json({ entries, durable: true });
    }),
  );

  // ── document bytes (local storage adapter only) ────────────────────────────
  //
  // Two independent checks, deliberately. The signature proves the URL was minted by this
  // server and has not expired; the admin session proves the person redeeming it is staff. A
  // signed URL alone is a bearer capability — it leaks through history, screenshots and
  // referrers — and an admin session alone would let any key be guessed at. Requiring both
  // means a leaked URL is useless to a non-admin and an admin still cannot read arbitrary keys.
  router.get(
    "/admin/documents/raw",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const key = String(req.query.key ?? "");
      const expires = Number(req.query.expires ?? 0);
      const sig = String(req.query.sig ?? "");
      if (!key || !sig || !verifyLocalSignature(key, expires, sig, deps.now())) {
        res.status(403).json({ error: "invalid-or-expired-signature" });
        return;
      }
      const object = await deps.storage.get(key);
      if (!object) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      res.setHeader("Content-Type", object.contentType);
      // Never inline. An HTML or SVG document rendered in the admin origin would be stored
      // XSS against the highest-privilege session on the platform; the byte-sniffing on upload
      // should already prevent one existing, but this is the second lock on the same door.
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Belt and braces against a proxy or the browser caching someone's ID scan on disk.
      res.setHeader("Cache-Control", "no-store, private");
      res.send(object.bytes);
    }),
  );

  return router;
}
