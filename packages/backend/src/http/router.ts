import { Router, type NextFunction, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  MatchedHelper,
  PublicTask,
  SessionSnapshot,
  Task,
  TaskCategory,
  TaskSnapshot,
} from "@needy/shared";
import {
  CATEGORY_PRICING,
  EXCEPTION_REVIEW_SLA_MS,
  isAwaitingNamedHelper,
  pairingDecision,
  scheduleProblem,
  publicTask,
} from "@needy/shared";
import type { DbPool } from "../db.js";
import type { Deps } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import { getTaskLocation } from "../domain/location-store.js";
import { readPresence } from "../domain/presence-store.js";
import { participantSosView } from "../domain/sosEscalation.js";
import { signAccessToken, type AuthClaims } from "../auth/jwt.js";
import { readAccessClaims } from "../auth/middleware.js";
import { requireOnboarded, REQUESTER_ROLES } from "../auth/onboardingGate.js";
import { computeEta } from "../services/eta.js";
import { consumeToken, type RateLimit } from "../services/ratelimit.js";
import { asyncRoute } from "./asyncRoute.js";

/** Burst of ten, refilling at one every ten seconds. See the note at the call site. */
const CREATE_TASK_LIMIT: RateLimit = { capacity: 10, ratePerSec: 0.1 };

/** Requests one person may have open (not completed, cancelled or unmatched) at once. */
export const MAX_OPEN_REQUESTS = 3;

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
  /** Catalog service code. Optional for now so existing clients keep working; when absent
   *  the task matches any helper, which is the pre-catalog behaviour. */
  serviceCode: z.string().trim().min(1).max(64).optional(),
  /** Epoch ms. Present only for an exception-gated booking, which needs a day's lead time
   *  because a human has to review two video testimonies before it can go ahead. */
  scheduledFor: z.number().int().positive().optional(),
  /** Required when the pairing is restricted: the specific helper this booking is for. A
   *  restricted pairing is unlocked per-pair, so there is nothing to check without it. */
  helperId: z.string().trim().min(1).max(128).optional(),
});

const devTokenSchema = z.object({
  userId: z.string().min(1).max(128),
  role: z.enum(["requester", "helper"]),
  displayName: z.string().trim().min(1).max(80),
});

/** Race a probe against a timeout. Resolves false rather than throwing so one unhealthy
 *  dependency reports as unhealthy instead of failing the whole handler. Exported so the
 *  metrics scrape probes dependencies exactly the way /health does. */
export async function probe(run: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
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
  if (deps.config.devTokenRoute) {
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
    // Also publish the full claims under `user`, which is the shape the shared middleware in
    // auth/middleware.ts sets and therefore what everything downstream of it reads. This
    // router predates that module and had its own narrower convention; chaining a shared
    // guard like `requireOnboarded` after this one silently saw no principal and failed
    // closed with a 401, which reads exactly like an expired token and is a genuinely
    // confusing way to debug. Setting both keeps the two conventions from diverging again.
    (req as AuthedRequest & { user?: typeof claims }).user = claims;
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
    // Creating a task is transacting, and an unapproved account may not. Placed BEFORE body
    // validation deliberately: an unapproved caller should be told they are not approved, not
    // handed a field-by-field critique of a request that was never going to be accepted.
    // And only an account that asks for help may ask for it. "Signed in and approved" let a
    // helper-only or staff account open a request; AGENTS.md is explicit that being logged
    // in is not a role check.
    requireOnboarded({ users: deps.users }, { roles: REQUESTER_ROLES }),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const requesterId = req.userId!;

      // AGENTS.md requires Redis-backed rate limiting on "task creation, chat, and SOS".
      // Chat and SOS had it; this route did not, so the one endpoint that fans work out to
      // every nearby helper was the one an unbounded loop could hammer. Each unanswered
      // request also occupies real people's attention for a full offer window, which is what
      // makes this worth limiting even though nothing here is expensive to store.
      //
      // Sized for a person, not a script: ten in a burst covers someone retrying a search
      // that found nobody, and the slow refill makes a sustained loop pointless.
      const allowed = await consumeToken(
        deps.redis.client,
        keys.bucket("create-task", requesterId),
        CREATE_TASK_LIMIT,
        deps.now(),
      );
      if (!allowed) {
        res.status(429).json({ error: "too-many-requests" });
        return;
      }

      // The rate limit bounds how FAST requests open, not how many are open at once: ten in a
      // burst could all be searching together, each fanning offers out to every nearby helper.
      // A person needs a few at most (a booking for later plus something now).
      const open = (await deps.tasks.activeForUser(requesterId)).filter(
        (t) => t.requesterId === requesterId,
      );
      if (open.length >= MAX_OPEN_REQUESTS) {
        res.status(409).json({ error: "too-many-open-requests", maxOpen: MAX_OPEN_REQUESTS });
        return;
      }

      const parsed = createTaskSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "invalid-input", details: parsed.error.flatten() });
        return;
      }
      const { category, origin, title, description, serviceCode, scheduledFor, helperId } =
        parsed.data;
      try {
        const now = deps.now();

        // ── the eligibility gate ────────────────────────────────────────────
        // Only reachable when the requester named a specific helper, which is what a
        // restricted booking must do. An open search does not name one, and the matrix is
        // applied per candidate inside matching instead — see `findEligibleHelpers`.
        if (helperId) {
          const [requester, helper] = await Promise.all([
            deps.users.getById(requesterId),
            deps.users.getById(helperId),
          ]);
          if (!helper) {
            res.status(404).json({ error: "helper-not-found" });
            return;
          }
          const decision = pairingDecision(
            requester ?? { dateOfBirth: null, gender: null },
            helper,
            now,
          );
          if (decision.kind === "denied") {
            res.status(403).json({ error: "pairing-denied", reason: decision.reason });
            return;
          }
          if (decision.kind === "requires-exception") {
            // An approved, unexpired exception for this exact ordered pair is the only thing
            // that unlocks it. Checked here rather than trusted from the client, which has
            // its own copy of the matrix purely to explain the rule, not to enforce it.
            const approved = await deps.exceptions.isApproved(requesterId, helperId, now);
            if (!approved) {
              res.status(403).json({
                error: "exception-required",
                reason: decision.reason,
                requesterId,
                helperId,
              });
              return;
            }
            // Exception-gated bookings are scheduled, not live: the approval that permits
            // them takes up to a working day, so there is a lead time to respect.
            if (scheduledFor == null) {
              res.status(422).json({ error: "schedule-required" });
              return;
            }
          }
        }

        if (scheduledFor != null) {
          const problem = scheduleProblem(scheduledFor, now);
          if (problem) {
            res.status(422).json({
              error: "invalid-schedule",
              problem,
              minimumLeadMs: EXCEPTION_REVIEW_SLA_MS,
            });
            return;
          }
        }

        const price = CATEGORY_PRICING[category];
        const task: Task = {
          id: nanoid(),
          requesterId,
          // A scheduled booking is already tied to the helper the exception was granted for.
          // Assigning it here is what stops the search fanning it out to strangers.
          helperId: helperId ?? null,
          // Narrowed by zod against the real union — no cast (see TASK_CATEGORIES).
          category,
          state: "searching",
          origin: { lat: origin.lat, lng: origin.lng },
          title,
          description,
          price,
          serviceCode: serviceCode ?? null,
          scheduledFor: scheduledFor ?? null,
          serviceBrief: null,
          handoffOtpHash: null,
          handoffOtpExpiresAt: null,
          handoffVerifiedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        const created = await deps.tasks.create(task);
        res.status(201).json(publicTask(created));
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
               AND state IN ('completed', 'cancelled', 'unmatched')
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
      res.json({ task: taskForViewer(task, userId) });
    }),
  );

  return router;
}

/**
 * A task as one particular person may see it.
 *
 * A named helper who has not accepted yet gets the area, not the door — the same promise every
 * offer card makes ("exact address once you accept"). Their unconfirmed bookings reach them
 * through the snapshot and this route, and until now both carried the exact origin.
 */
function taskForViewer(task: Task, viewerId: string): PublicTask {
  const view = publicTask(task);
  if (isAwaitingNamedHelper(task) && viewerId === task.helperId) {
    const coarse = (n: number) => Math.round(n * 1000) / 1000;
    return { ...view, origin: { lat: coarse(task.origin.lat), lng: coarse(task.origin.lng) } };
  }
  return view;
}

/** Assemble one TaskSnapshot: current location, the reveal card (with live ETA), the
 *  message log, and the OTHER party's presence so the requester sees the helper's status. */
async function buildTaskSnapshot(deps: Deps, task: Task, callerId: string): Promise<TaskSnapshot> {
  const redis = deps.redis.client;
  const lastKnownLocation = await getTaskLocation(redis, task.id);

  const eta = lastKnownLocation
    ? await computeEta(lastKnownLocation, task.origin, { cacheKey: task.id, now: deps.now() })
    : null;

  let helper: MatchedHelper | null = null;
  if (task.helperId) {
    const profile = await deps.helpers.get(task.helperId);
    if (profile) {
      helper = { ...profile, etaSeconds: eta ? eta.etaSeconds : null };
    }
  }

  const messages = await deps.messages.list(task.id);

  // The live alarm, if any. Oldest first so a task that somehow carries two surfaces the one
  // that has been waiting longest rather than whichever the store happened to return first.
  const alarms = await deps.sos.activeForTask(task.id);
  const oldest = [...alarms].sort((a, b) => a.createdAt - b.createdAt)[0];
  // A participant's view: who on the staff side has been paged about it is not theirs to see.
  const sos = oldest ? participantSosView(oldest) : null;

  // Presence is only surfaced to the requester, showing the matched helper's status.
  const presence =
    callerId === task.requesterId && task.helperId
      ? await readPresence(redis, task.helperId)
      : null;

  return {
    // Stripped of the handoff credential. `/snapshot` is the boundary that made this
    // exploitable rather than merely untidy: it is the reconnect path, so the HELPER's own
    // client calls it routinely — and it returns every task they are party to, including one
    // sitting in `arrived` with a live code. See `publicTask`.
    task: taskForViewer(task, callerId),
    helper,
    lastKnownLocation,
    eta: eta
      ? {
          etaSeconds: eta.etaSeconds,
          distanceMeters: eta.distanceMeters,
          approximate: eta.approximate,
          ...(eta.polyline ? { polyline: eta.polyline } : {}),
        }
      : null,
    messages,
    presence,
    sos,
  };
}
