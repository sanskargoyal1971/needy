import { Router, type Response } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import { CATEGORY_PRICING, HELPER_SHARE_PERCENT, type HelperApplication } from "@needy/shared";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import type { UserRepository } from "../auth/repos.js";
import type { HelperApplicationRepository } from "./repos.js";
import type { HelperProfileRepository, TaskRepository } from "../domain/stores.js";
import { asyncRoute } from "../http/asyncRoute.js";
import { validateBody } from "../auth/validation.js";
import { logger } from "../logger.js";
import type { DbPool } from "../db.js";

export interface AdminRouterDeps {
  applications: HelperApplicationRepository;
  users: UserRepository;
  helpers: HelperProfileRepository;
  tasks: TaskRepository;
  now: () => number;
  pool: DbPool | null;
}

// ── validation schemas ────────────────────────────────────────────────────

const applySchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  phone: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/),
  aadhaarLast4: z.string().regex(/^\d{4}$/, "exactly 4 digits"),
  experience: z.string().trim().min(10).max(1000),
});

const reviewSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
});

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();

  // ── apply to become a helper ──────────────────────────────────────────────
  router.post(
    "/helpers/apply",
    requireAuth,
    validateBody(applySchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const userId = req.user!.sub;
      try {
        // Check for existing pending application
        const existing = await deps.applications.getByUserId(userId);
        if (existing) {
          res.status(409).json({ error: "application-already-pending", application: existing });
          return;
        }

        const user = await deps.users.getById(userId);
        if (!user) {
          res.status(404).json({ error: "user-not-found" });
          return;
        }
        // Already a helper? No need to re-apply.
        if (user.role === "helper" || user.role === "both" || user.role === "admin") {
          res.status(400).json({ error: "already-a-helper" });
          return;
        }

        const body = req.body as z.infer<typeof applySchema>;
        const now = deps.now();
        const application: HelperApplication = {
          id: nanoid(),
          userId,
          displayName: body.displayName,
          phone: body.phone,
          aadhaarLast4: body.aadhaarLast4,
          experience: body.experience,
          status: "pending",
          reviewedBy: null,
          reviewNote: null,
          createdAt: now,
          updatedAt: now,
        };

        const created = await deps.applications.create(application);
        res.status(201).json({ application: created });
      } catch (err) {
        logger.error("helper application failed", { userId, err: String(err) });
        res.status(500).json({ error: "application-failed" });
      }
    }),
  );

  // ── check my application status ───────────────────────────────────────────
  router.get(
    "/helpers/application/status",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const app = await deps.applications.getByUserId(req.user!.sub);
      res.json({ application: app });
    }),
  );

  // ── helper earnings ───────────────────────────────────────────────────────
  router.get(
    "/helpers/me/earnings",
    requireAuth,
    requireRole("helper"),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const userId = req.user!.sub;
      try {
        // Count completed tasks where this user was the helper
        if (deps.pool) {
          const { rows } = await deps.pool.query<{ total: string; count: string }>(
            `SELECT COALESCE(SUM(price * ${HELPER_SHARE_PERCENT} / 100), 0) as total, COUNT(*) as count
             FROM tasks WHERE helper_id = $1 AND state = 'completed'`,
            [userId],
          );
          res.json({
            totalEarnings: Number(rows[0]?.total ?? 0),
            completedTasks: Number(rows[0]?.count ?? 0),
            sharePercent: HELPER_SHARE_PERCENT,
          });
        } else {
          // In-memory fallback: no SQL, just return 0
          res.json({ totalEarnings: 0, completedTasks: 0, sharePercent: HELPER_SHARE_PERCENT });
        }
      } catch (err) {
        logger.error("earnings query failed", { userId, err: String(err) });
        res.status(500).json({ error: "earnings-query-failed" });
      }
    }),
  );

  // ── ADMIN: list applications ──────────────────────────────────────────────
  router.get(
    "/admin/applications",
    requireAuth,
    requireRole("admin"),
    asyncRoute(async (_req: AuthedRequest, res: Response) => {
      const applications = await deps.applications.listAll();
      res.json({ applications });
    }),
  );

  // ── ADMIN: get single application ─────────────────────────────────────────
  router.get(
    "/admin/applications/:id",
    requireAuth,
    requireRole("admin"),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const app = await deps.applications.getById(req.params.id);
      if (!app) {
        res.status(404).json({ error: "application-not-found" });
        return;
      }
      res.json({ application: app });
    }),
  );

  // ── ADMIN: review (approve/reject) an application ─────────────────────────
  router.post(
    "/admin/applications/:id/review",
    requireAuth,
    requireRole("admin"),
    validateBody(reviewSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const adminId = req.user!.sub;
      const appId = req.params.id;
      const { decision, note } = req.body as z.infer<typeof reviewSchema>;

      try {
        const app = await deps.applications.getById(appId);
        if (!app) {
          res.status(404).json({ error: "application-not-found" });
          return;
        }
        if (app.status !== "pending") {
          res.status(400).json({ error: "application-already-reviewed" });
          return;
        }

        const now = deps.now();

        // Update the application
        const updated = await deps.applications.update(appId, {
          status: decision,
          reviewedBy: adminId,
          reviewNote: note ?? null,
          updatedAt: now,
        });

        if (decision === "approved") {
          // Upgrade user role to "both" and KYC to "verified"
          await deps.users.update(app.userId, {
            role: "both",
            kycStatus: "verified",
            updatedAt: now,
          });

          // Create a helpers row for matching
          if (deps.pool) {
            await deps.pool.query(
              `INSERT INTO helpers (id, display_name, photo_url, bio, rating, helped_count, total_earnings)
               VALUES ($1, $2, '', $3, 0, 0, 0)
               ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, bio = EXCLUDED.bio`,
              [app.userId, app.displayName, app.experience],
            );
          }
        }

        logger.info("application reviewed", {
          appId,
          decision,
          adminId,
          userId: app.userId,
        });

        res.json({ application: updated });
      } catch (err) {
        logger.error("application review failed", { appId, err: String(err) });
        res.status(500).json({ error: "review-failed" });
      }
    }),
  );

  // ── ADMIN: list all users ─────────────────────────────────────────────────
  router.get(
    "/admin/users",
    requireAuth,
    requireRole("admin"),
    asyncRoute(async (_req: AuthedRequest, res: Response) => {
      try {
        if (deps.pool) {
          const { rows } = await deps.pool.query(
            `SELECT id, phone, display_name, role, kyc_status, created_at FROM users ORDER BY created_at DESC LIMIT 100`,
          );
          res.json({
            users: rows.map((r: Record<string, unknown>) => ({
              id: r.id,
              phone: r.phone,
              displayName: r.display_name,
              role: r.role,
              kycStatus: r.kyc_status,
              createdAt: Number(r.created_at),
            })),
          });
        } else {
          res.json({ users: [] });
        }
      } catch (err) {
        logger.error("admin users list failed", { err: String(err) });
        res.status(500).json({ error: "users-list-failed" });
      }
    }),
  );

  // ── ADMIN: dashboard stats ────────────────────────────────────────────────
  router.get(
    "/admin/stats",
    requireAuth,
    requireRole("admin"),
    asyncRoute(async (_req: AuthedRequest, res: Response) => {
      try {
        if (deps.pool) {
          const [usersR, helpersR, tasksR, revenueR, pendingR] = await Promise.all([
            deps.pool.query<{ count: string }>("SELECT COUNT(*) as count FROM users"),
            deps.pool.query<{ count: string }>("SELECT COUNT(*) as count FROM users WHERE role IN ('helper','both')"),
            deps.pool.query<{ count: string; completed: string }>(
              "SELECT COUNT(*) as count, COUNT(*) FILTER (WHERE state = 'completed') as completed FROM tasks",
            ),
            deps.pool.query<{ total: string }>(
              "SELECT COALESCE(SUM(price), 0) as total FROM tasks WHERE state = 'completed'",
            ),
            deps.pool.query<{ count: string }>(
              "SELECT COUNT(*) as count FROM helper_applications WHERE status = 'pending'",
            ),
          ]);
          res.json({
            totalUsers: Number(usersR.rows[0]?.count ?? 0),
            totalHelpers: Number(helpersR.rows[0]?.count ?? 0),
            totalTasks: Number(tasksR.rows[0]?.count ?? 0),
            completedTasks: Number(tasksR.rows[0]?.completed ?? 0),
            totalRevenue: Number(revenueR.rows[0]?.total ?? 0),
            pendingApplications: Number(pendingR.rows[0]?.count ?? 0),
            categoryPricing: CATEGORY_PRICING,
          });
        } else {
          res.json({
            totalUsers: 0,
            totalHelpers: 0,
            totalTasks: 0,
            completedTasks: 0,
            totalRevenue: 0,
            pendingApplications: 0,
            categoryPricing: CATEGORY_PRICING,
          });
        }
      } catch (err) {
        logger.error("admin stats failed", { err: String(err) });
        res.status(500).json({ error: "stats-failed" });
      }
    }),
  );

  return router;
}
