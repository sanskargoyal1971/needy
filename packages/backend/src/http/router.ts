import { Router, type NextFunction, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  MatchedHelper,
  SessionSnapshot,
  Task,
  TaskCategory,
  TaskSnapshot,
} from "@needy/shared";
import { CATEGORY_PRICING } from "@needy/shared";
import type { DbPool } from "../db.js";
import type { Deps } from "../domain/deps.js";
import { getTaskLocation } from "../domain/location-store.js";
import { readPresence } from "../domain/presence-store.js";
import { signAccessToken, type AuthClaims } from "../auth/jwt.js";
import { readAccessClaims } from "../auth/middleware.js";
import { computeEta } from "../services/eta.js";
import { asyncRoute } from "./asyncRoute.js";

/** Request carrying the userId resolved by the bearer-auth middleware. Kept local since
 *  it's only meaningful behind `requireAuth`. */
export interface AuthedRequest extends Request {
  userId?: string;
}

export interface HttpRouterOptions {
  /** Postgres pool, purely so GET /health can prove the database actually answers. Optional and
   *  nullable because dev/test run on the in-memory repositories with no database at all — and
   *  "not configured" is healthy, not down. */
  db?: DbPool | null;
  /** Ceiling on how long a single /health dependency probe may take. A readiness endpoint that
   *  hangs is worse than one that says "down": a load balancer reads the hang as a timeout on
   *  every check and can't distinguish a slow dependency from a wedged process. */
  healthProbeTimeoutMs?: number;
}

/** ── request validation ───────────────────────────────────────────────────────
 *  Every REST body is parsed with zod, mirroring what `auth/` and `socket/validation.ts`
 *  already do. `finite` rejects NaN and ±Infinity, which bare `z.number()` accepts and which
 *  would otherwise flow into the GEO index and the ETA maths as poison. */
const finite = z.number().finite();

/** The category list zod validates against. Audit fix: POST /tasks did `category as
 *  TaskCategory` — a blind cast, so any string at all became a "category" and was persisted,
 *  reaching matching (which weights on category) as a value the union says cannot exist.
 *  The type-level check below fails compilation if `TaskCategory` ever grows a member that
 *  isn't listed here, so the runtime check can't silently fall behind the type. */
const TASK_CATEGORIES = ["errand", "companionship", "social-service", "urgent"] as const;
type CategoriesAreExhaustive = TaskCategory extends (typeof TASK_CATEGORIES)[number] ? true : never;
const _categoriesAreExhaustive: CategoriesAreExhaustive = true;
void _categoriesAreExhaustive;

const createTaskSchema = z.object({
  category: z.enum(TASK_CATEGORIES),
  origin: z.object({
    lat: finite.min(-90).max(90),
    lng: finite.min(-180).max(180),
  }),
  /** Trimmed and capped: the title is rendered in the helper's offer card and stored in a
   *  TEXT column, so an unbounded string is both a layout problem and a free write amplifier. */
  title: z.string().trim().min(1).max(140),
  /** What the requester actually needs help with. */
  description: z.string().trim().min(1).max(500),
});

const devTokenSchema = z.object({
  userId: z.string().min(1).max(128),
  role: z.enum(["requester", "helper"]),
  displayName: z.string().trim().min(1).max(80),
});

/** Race a probe against a timeout. Resolves false rather than throwing so one unhealthy
 *  dependency reports as unhealthy instead of failing the whole handler. */
async function probe(run: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("probe-timeout")), timeoutMs);
      // Don't hold the event loop open on a probe (matters for short-lived CLI/test processes).
      timer.unref?.();
    });
    await Promise.race([run(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The REST layer (§2.1). Its centerpiece is GET /snapshot, the authoritative post-drop
 *  truth a reconnecting client re-syncs from before it trusts any new socket event. */
export function createHttpRouter(deps: Deps, options: HttpRouterOptions = {}): Router {
  const router = Router();
  // Audit fix: a `const redis = deps.redis.client` used to shadow here and was never read —
  // `buildTaskSnapshot` reaches for its own. Removed rather than left as a decoy.

  const healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? 2_000;

  // ── readiness ──────────────────────────────────────────────────────────────
  // Audit fix: this returned a static `{ ok: true }`, which made it a liveness check wearing a
  // readiness check's name. With Redis down (all presence/matching/tracking state) or Postgres
  // down (every task and message), the process still answered 200 — so an orchestrator would
  // happily keep routing traffic to, or roll a deploy onto, an instance that cannot serve a
  // single request. Both dependencies are now actually exercised and a failure is a 503.
  router.get(
    "/health",
    asyncRoute(async (_req: Request, res: Response) => {
      // The health flag from redis.ts (audit B8) is a free read of ioredis' connection state; a
      // PING then proves the server on the other end is genuinely answering commands and not just
      // holding an open socket.
      const redisState = deps.redis.health?.snapshot() ?? null;
      const redisOk =
        (redisState === null || redisState.ready) &&
        (await probe(() => deps.redis.client.ping(), healthProbeTimeoutMs));

      // `SELECT 1` is the cheapest statement that proves a connection can be checked out of the
      // pool and round-trip a query. `undefined`/null pool = in-memory mode, nothing to check.
      const dbOk =
        options.db == null
          ? true
          : await probe(() => options.db!.query("SELECT 1"), healthProbeTimeoutMs);

      const ok = redisOk && dbOk;
      if (!ok) {
        deps.logger.warn("health check failed", {
          redisOk,
          dbOk,
          redisConnections: redisState?.connections.map((c) => ({
            role: c.role,
            status: c.status,
            errorCount: c.errorCount,
          })),
        });
      }
      // 503 is the contract an orchestrator/load balancer reads: "alive but not ready for
      // traffic". The body names the failing dependency so an operator doesn't have to guess.
      res.status(ok ? 200 : 503).json({
        ok,
        serverTime: deps.now(),
        dependencies: {
          redis: redisOk ? "ok" : "unavailable",
          database: options.db == null ? "not-configured" : dbOk ? "ok" : "unavailable",
        },
      });
    }),
  );

  // ── DEV ONLY ─────────────────────────────────────────────────────────────
  // Mints a signed access token for ANY userId with ANY role — i.e. it is a total
  // authentication bypass for every account in the system.
  //
  // Audit A4: the comment here used to say "MUST NOT be mounted in production" and NOTHING
  // enforced it; `config.env` existed and was read nowhere in the codebase, so this shipped
  // unconditionally. It is now mounted only when `config.allowDevRoutes` (development/test).
  // In any other environment the route is never registered at all, so it 404s exactly like a
  // nonexistent path — deliberately not a 403, which would confirm to a prober that a token
  // minting endpoint exists here and invite them to look for a way through it.
  if (deps.config.allowDevRoutes) {
    router.post("/dev/token", (req: Request, res: Response) => {
      const parsed = devTokenSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "userId, role and displayName required" });
        return;
      }
      const claims: AuthClaims = {
        sub: parsed.data.userId,
        role: parsed.data.role,
        displayName: parsed.data.displayName,
      };
      res.json({ token: signAccessToken(claims) });
    });
  } else {
    deps.logger.info("dev routes not mounted", { env: deps.config.env });
  }

  // ── bearer auth ─────────────────────────────────────────────────────────────
  // Same short-lived JWT as the socket handshake; on failure the client re-auths.
  const requireAuth = (req: AuthedRequest, res: Response, next: NextFunction): void => {
    // Accepts the httpOnly access cookie (real auth) or a Bearer token (dev/tests).
    const claims = readAccessClaims(req);
    if (!claims) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.userId = claims.sub;
    next();
  };

  // ── reconnect snapshot (§2.1) ────────────────────────────────────────────
  // Rebuilds the full authoritative state for the caller across all active tasks.
  router.get(
    "/snapshot",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const userId = req.userId!;
      try {
        const tasks = await deps.tasks.activeForUser(userId);
        const activeTasks = await Promise.all(
          tasks.map((task) => buildTaskSnapshot(deps, task, userId)),
        );
        const snapshot: SessionSnapshot = {
          userId,
          serverTime: deps.now(),
          activeTasks,
        };
        res.json(snapshot);
      } catch (err) {
        deps.logger.error("snapshot failed", { userId, err: String(err) });
        res.status(500).json({ error: "snapshot failed" });
      }
    }),
  );

  // ── create task ─────────────────────────────────────────────────────────────
  // Frontend calls this before emitting request-help; the task opens in "searching".
  router.post(
    "/tasks",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const requesterId = req.userId!;
      const parsed = createTaskSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "invalid-input", details: parsed.error.flatten() });
        return;
      }
      const { category, origin, title, description } = parsed.data;
      try {
        const now = deps.now();
        const price = CATEGORY_PRICING[category];
        const task: Task = {
          id: nanoid(),
          requesterId,
          helperId: null,
          // Narrowed by zod against the real union — no cast (see TASK_CATEGORIES).
          category,
          state: "searching",
          origin: { lat: origin.lat, lng: origin.lng },
          title,
          description,
          price,
          createdAt: now,
          updatedAt: now,
        };
        const created = await deps.tasks.create(task);
        res.status(201).json(created);
      } catch (err) {
        deps.logger.error("create task failed", { requesterId, err: String(err) });
        res.status(500).json({ error: "create task failed" });
      }
    }),
  );

  // ── task history ────────────────────────────────────────────────────────────
  router.get(
    "/tasks/history",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const userId = req.userId!;
      try {
        if (options.db) {
          const { rows } = await options.db.query(
            `SELECT id, requester_id, helper_id, category, state, origin_lat, origin_lng,
                    title, description, price, created_at, updated_at
             FROM tasks
             WHERE (requester_id = $1 OR helper_id = $1)
               AND state IN ('completed', 'cancelled')
             ORDER BY updated_at DESC
             LIMIT 50`,
            [userId],
          );
          res.json({
            tasks: rows.map((r: Record<string, unknown>) => ({
              id: r.id,
              requesterId: r.requester_id,
              helperId: r.helper_id,
              category: r.category,
              state: r.state,
              origin: { lat: r.origin_lat, lng: r.origin_lng },
              title: r.title,
              description: r.description,
              price: Number(r.price),
              createdAt: Number(r.created_at),
              updatedAt: Number(r.updated_at),
            })),
          });
        } else {
          // In-memory: no history
          res.json({ tasks: [] });
        }
      } catch (err) {
        deps.logger.error("task history failed", { userId, err: String(err) });
        res.status(500).json({ error: "task-history-failed" });
      }
    }),
  );

  // ── single task detail ─────────────────────────────────────────────────────
  router.get(
    "/tasks/:id",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const userId = req.userId!;
      const task = await deps.tasks.get(req.params.id);
      if (!task) {
        res.status(404).json({ error: "task-not-found" });
        return;
      }
      if (task.requesterId !== userId && task.helperId !== userId) {
        res.status(403).json({ error: "not-a-participant" });
        return;
      }
      res.json({ task });
    }),
  );

  return router;
}

/** Assemble one TaskSnapshot: current location, the reveal card (with live ETA), the
 *  message log, and the OTHER party's presence so the requester sees the helper's status. */
async function buildTaskSnapshot(deps: Deps, task: Task, callerId: string): Promise<TaskSnapshot> {
  const redis = deps.redis.client;
  const lastKnownLocation = await getTaskLocation(redis, task.id);

  const eta = lastKnownLocation ? await computeEta(lastKnownLocation, task.origin) : null;

  let helper: MatchedHelper | null = null;
  if (task.helperId) {
    const profile = await deps.helpers.get(task.helperId);
    if (profile) {
      helper = { ...profile, etaSeconds: eta ? eta.etaSeconds : null };
    }
  }

  const messages = await deps.messages.list(task.id);

  // Presence is only surfaced to the requester, showing the matched helper's status.
  const presence =
    callerId === task.requesterId && task.helperId
      ? await readPresence(redis, task.helperId)
      : null;

  return {
    task,
    helper,
    lastKnownLocation,
    eta: eta ? { etaSeconds: eta.etaSeconds, distanceMeters: eta.distanceMeters } : null,
    messages,
    presence,
  };
}
