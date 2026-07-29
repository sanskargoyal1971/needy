import { Router, type NextFunction, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import type {
  MatchedHelper,
  SessionSnapshot,
  Task,
  TaskCategory,
  TaskSnapshot,
} from "@needy/shared";
import type { Deps } from "../domain/deps.js";
import { getTaskLocation } from "../domain/location-store.js";
import { readPresence } from "../domain/presence-store.js";
import { signAccessToken, type AuthClaims } from "../auth/jwt.js";
import { readAccessClaims } from "../auth/middleware.js";
import { computeEta } from "../services/eta.js";

/** Request carrying the userId resolved by the bearer-auth middleware. Kept local since
 *  it's only meaningful behind `requireAuth`. */
export interface AuthedRequest extends Request {
  userId?: string;
}

/** The REST layer (§2.1). Its centerpiece is GET /snapshot, the authoritative post-drop
 *  truth a reconnecting client re-syncs from before it trusts any new socket event. */
export function createHttpRouter(deps: Deps): Router {
  const router = Router();
  const redis = deps.redis.client;

  // ── liveness ───────────────────────────────────────────────────────────────
  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // ── DEV ONLY ─────────────────────────────────────────────────────────────
  // Mints a signed access token so local clients can authenticate before a real
  // auth system exists. MUST NOT be mounted in production.
  router.post("/dev/token", (req: Request, res: Response) => {
    const { userId, role, displayName } = req.body ?? {};
    if (
      typeof userId !== "string" ||
      (role !== "requester" && role !== "helper") ||
      typeof displayName !== "string"
    ) {
      res.status(400).json({ error: "userId, role and displayName required" });
      return;
    }
    const claims: AuthClaims = { sub: userId, role, displayName };
    res.json({ token: signAccessToken(claims) });
  });

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
  router.get("/snapshot", requireAuth, async (req: AuthedRequest, res: Response) => {
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
  });

  // ── create task ─────────────────────────────────────────────────────────────
  // Frontend calls this before emitting request-help; the task opens in "searching".
  router.post("/tasks", requireAuth, async (req: AuthedRequest, res: Response) => {
    const requesterId = req.userId!;
    const { category, origin, title } = req.body ?? {};
    if (
      typeof category !== "string" ||
      typeof title !== "string" ||
      typeof origin?.lat !== "number" ||
      typeof origin?.lng !== "number"
    ) {
      res.status(400).json({ error: "category, origin{lat,lng} and title required" });
      return;
    }
    try {
      const now = deps.now();
      const task: Task = {
        id: nanoid(),
        requesterId,
        helperId: null,
        category: category as TaskCategory,
        state: "searching",
        origin: { lat: origin.lat, lng: origin.lng },
        title,
        createdAt: now,
        updatedAt: now,
      };
      const created = await deps.tasks.create(task);
      res.status(201).json(created);
    } catch (err) {
      deps.logger.error("create task failed", { requesterId, err: String(err) });
      res.status(500).json({ error: "create task failed" });
    }
  });

  return router;
}

/** Assemble one TaskSnapshot: current location, the reveal card (with live ETA), the
 *  message log, and the OTHER party's presence so the requester sees the helper's status. */
async function buildTaskSnapshot(
  deps: Deps,
  task: Task,
  callerId: string,
): Promise<TaskSnapshot> {
  const redis = deps.redis.client;
  const lastKnownLocation = await getTaskLocation(redis, task.id);

  const eta = lastKnownLocation
    ? await computeEta(lastKnownLocation, task.origin)
    : null;

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
