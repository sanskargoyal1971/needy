import { Router, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AuditLogger } from "../audit/log.js";
import { requireAuth, requireStaff, type AuthedRequest } from "../auth/middleware.js";
import { hashPassword, passwordProblem, PASSWORD_MIN_LENGTH } from "../auth/password.js";
import type { SessionRepository, UserRepository } from "../auth/repos.js";
import { makeUser, type User } from "../auth/types.js";
import { phoneIndex } from "../crypto/pii.js";
import { phoneSchema, usernameSchema, validateBody } from "../auth/validation.js";
import { asyncRoute } from "../http/asyncRoute.js";
import { logger } from "../logger.js";

/** ── Staff administration ──────────────────────────────────────────────────
 *  The super admin's surface: who the operators are, and whether they can get in.
 *
 *  Reachable only by `super_admin`. That separation is the entire point — an ordinary admin
 *  who could create another admin could grant themselves a second account and use it to review
 *  their own decisions, and an admin who could deactivate another admin could lock the rest of
 *  the team out of the console during an incident. `satisfiesRole` gives `admin` everything
 *  EXCEPT `super_admin` for exactly this reason.
 *
 *  The number is assigned here, by the super admin, and is not the operator's to choose. A
 *  staff account is issued to a specific person on a number that person already gave the
 *  organisation; letting an admin register or re-point their own number would mean the second
 *  factor is delivered wherever whoever holds the password asks for it, which is not a second
 *  factor at all.
 */

const createStaffSchema = z.object({
  /** The number the second factor will be sent to. Assigned, never self-chosen. */
  phone: phoneSchema,
  displayName: z.string().trim().min(1).max(80),
  /** Their first password. They can change it afterwards; they cannot change their number. */
  password: z.string().min(1).max(128),
  /** Optional. An admin signs in by phone, so this is only useful if the account is ever
   *  promoted to super admin — which this route does not do. */
  username: usernameSchema.optional(),
});

const deactivateSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export interface StaffRouterDeps {
  /** Close the account's live sockets. Revoking sessions stops the next sign-in; this ends the
   *  connection that is already open. Optional so a router test need not stand up Socket.io. */
  disconnectUser?: (userId: string) => Promise<unknown>;
  users: UserRepository;
  sessions: SessionRepository;
  audit: AuditLogger;
  /** The operator accounts, and only those.
   *
   *  Narrower than "every user" on purpose: the ordinary `UserRepository` deliberately has no
   *  `list()` (see the note on `InMemoryUserRepository`), and a staff screen has no business
   *  pulling the whole users table into memory to filter four rows out of it. */
  listStaff: () => Promise<User[]>;
  now: () => number;
}

/** What the console shows about an operator. No password state beyond "they have one", and
 *  never the hash — which is not on `User` at all. */
function staffView(u: User) {
  return {
    id: u.id,
    username: u.username,
    phone: u.phone,
    displayName: u.displayName,
    role: u.role,
    active: u.blockedAt == null,
    deactivatedAt: u.blockedAt,
    deactivatedReason: u.blockedAt != null ? u.rejectionReason : null,
    hasPassword: u.passwordSetAt != null,
    createdAt: u.createdAt,
  };
}

export function createStaffRouter(deps: StaffRouterDeps): Router {
  const router = Router();
  const superAdminOnly = [requireAuth, requireStaff(deps.users, "super_admin")] as const;
  const ip = (req: Request) => req.ip ?? req.socket?.remoteAddress ?? null;

  // ── who the operators are ──────────────────────────────────────────────────
  router.get(
    "/admin/staff",
    ...superAdminOnly,
    asyncRoute(async (_req: AuthedRequest, res: Response) => {
      const staff = (await deps.listStaff())
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(staffView);
      res.json({ staff });
    }),
  );

  // ── create an operator ─────────────────────────────────────────────────────
  router.post(
    "/admin/staff",
    ...superAdminOnly,
    validateBody(createStaffSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const actorId = req.user!.sub;
      const body = req.body as z.infer<typeof createStaffSchema>;
      const now = deps.now();

      // A number already in use is a person who already has an account. Promoting it silently
      // would turn an ordinary user into an operator without anyone deciding to, so this
      // refuses and leaves the decision where it belongs.
      if (await deps.users.getByPhone(body.phone)) {
        res.status(409).json({ error: "phone-in-use" });
        return;
      }
      if (body.username && (await deps.users.getByUsername(body.username))) {
        res.status(409).json({ error: "username-in-use" });
        return;
      }

      const problem = passwordProblem(body.password, body.phone);
      if (problem) {
        res.status(422).json({ error: "weak-password", problem, minLength: PASSWORD_MIN_LENGTH });
        return;
      }

      // Hashed BEFORE the account exists, deliberately.
      //
      // These are two writes with no transaction between them, and the failure that matters is
      // "account created, password not set": the number is then taken, so every retry is
      // refused with `phone-in-use`, and the operator it was created for cannot sign in. Doing
      // the expensive, fallible part first shrinks that window to a single UPDATE. If even that
      // fails the account is switched off rather than left as a live login nobody can use.
      const hash = await hashPassword(body.password);

      const created = await deps.users.create(
        makeUser({
          id: nanoid(),
          phone: body.phone,
          displayName: body.displayName,
          username: body.username ?? null,
          role: "admin",
          // Approved and verified on creation: a staff account is issued by a person who has
          // already decided, and sending an operator through the public review funnel would
          // put their ID documents in the very queue they are being hired to review.
          onboardingStatus: "approved",
          kycStatus: "verified",
          createdAt: now,
          updatedAt: now,
          reviewedBy: actorId,
          reviewedAt: now,
        }),
      );
      try {
        await deps.users.setPasswordHash(created.id, hash, now, actorId);
      } catch (err) {
        // Switched off rather than left as a staff account that exists, holds the number, and
        // cannot be signed into. A deactivated row is visible in the list and reactivatable;
        // an invisible half-made admin is a support ticket nobody can diagnose.
        await deps.users
          .update(created.id, {
            blockedAt: now,
            rejectionReason: "created without a password — retry",
            updatedAt: now,
          })
          .catch(() => {});
        logger.error("staff account created but password could not be set", {
          actorId,
          userId: created.id,
          err: String(err),
        });
        res.status(500).json({ error: "staff-created-without-password", userId: created.id });
        return;
      }

      await deps.audit.record({
        action: "admin.staff_created",
        actorId,
        actorRole: "super_admin",
        subjectType: "user",
        subjectId: created.id,
        // The password is never recorded. What matters later is who was made an operator, by
        // whom, and on which number — but not the number itself. audit_log is append-only and
        // outside the field encryption, so a number written here would outlive every effort
        // to seal it in `users`, readable in any dump for as long as the log is kept. The last
        // four digits are what an operator recognises; the blind index (the same digest
        // `users.phone_hash` holds) lets an investigation with the key confirm WHICH number,
        // without the log revealing it to anyone without one. Entries written before this
        // change hold the number in the clear and, the log being append-only, stay that way.
        metadata: {
          phoneLast4: created.phone.replace(/\D/g, "").slice(-4),
          phoneHash: phoneIndex(created.phone),
          username: created.username,
        },
        ip: ip(req),
      });
      // Not the number here either: log lines are shipped and retained further than the
      // database is.
      logger.warn("super admin created a staff account", { actorId, userId: created.id });

      res.status(201).json({ staff: staffView({ ...created, passwordSetAt: now }) });
    }),
  );

  // ── switch an operator off, and on again ───────────────────────────────────
  //
  // Deactivation revokes every session immediately rather than waiting for a token to expire.
  // The reason to switch an operator off is usually that they should not be looking at the
  // console right now, and a 15-minute window in which they still can is not that.
  router.post(
    "/admin/staff/:userId/deactivate",
    ...superAdminOnly,
    validateBody(deactivateSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const actorId = req.user!.sub;
      const { reason } = req.body as z.infer<typeof deactivateSchema>;
      const user = await deps.users.getById(req.params.userId);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }
      // Locking yourself out of the only account that can unlock accounts is unrecoverable
      // without a database console.
      if (user.id === actorId) {
        res.status(403).json({ error: "cannot-deactivate-self" });
        return;
      }
      if (user.role === "super_admin") {
        res.status(403).json({ error: "cannot-deactivate-super-admin" });
        return;
      }

      const now = deps.now();
      const updated = await deps.users.update(user.id, {
        blockedAt: now,
        rejectionReason: reason,
        updatedAt: now,
      });
      await deps.sessions.revokeAllForUser(user.id, now);
      await deps.disconnectUser?.(user.id);

      await deps.audit.record({
        action: "admin.user_blocked",
        actorId,
        actorRole: "super_admin",
        subjectType: "user",
        subjectId: user.id,
        metadata: { reason, staff: true },
        ip: ip(req),
      });
      res.json({ staff: staffView(updated) });
    }),
  );

  router.post(
    "/admin/staff/:userId/activate",
    ...superAdminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const actorId = req.user!.sub;
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
      await deps.audit.record({
        action: "admin.user_unblocked",
        actorId,
        actorRole: "super_admin",
        subjectType: "user",
        subjectId: user.id,
        metadata: { staff: true },
        ip: ip(req),
      });
      res.json({ staff: staffView(updated) });
    }),
  );

  return router;
}
