import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { NS, publicTask, type Task } from "@needy/shared";
import { requireAuth, type AuthedRequest } from "../auth/middleware.js";
import { requireOnboarded } from "../auth/onboardingGate.js";
import { validateBody } from "../auth/validation.js";
import type { Deps } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import { emitSignal } from "../domain/abuseStore.js";
import { consumeToken, type RateLimit } from "../services/ratelimit.js";
import { asyncRoute } from "./asyncRoute.js";

/** ── The doorstep handoff ──────────────────────────────────────────────────
 *  The moment a stranger is actually let in. Three steps, in order:
 *
 *   1. The helper posts a BRIEF — what they will do, and what they will not.
 *   2. The requester reads it and, if satisfied, reveals a one-time code.
 *   3. The requester says the code aloud; the helper types it in.
 *
 *  Only then does the task become `in-progress`. `TRANSITION_ACTORS["in-progress"]` is empty
 *  precisely so this is the only writer: leaving that edge advanceable would make the whole
 *  handoff skippable with a single socket frame.
 *
 *  Why the code travels through the physical world rather than the network: the requester
 *  reads it off their own screen and speaks it to the person standing in front of them. That
 *  is what makes it evidence of PRESENCE — the helper cannot enter it from down the street,
 *  and a stranger who has learned the task id cannot enter it at all. A code emailed or
 *  pushed to the helper would prove nothing except that they hold a phone.
 */

/** Six digits. Long enough that guessing inside the attempt budget is hopeless, short enough
 *  to say out loud to someone hard of hearing without repeating it three times. */
const CODE_LENGTH = 6;

/** The window between revealing the code and entering it. Generous for an elderly requester
 *  reading digits aloud; far short of leaving a live credential lying around. */
const CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Attempts before the code is burned.
 *
 * Five wrong guesses is well past a mistyped digit and well short of brute force: with 10^6
 * codes, five tries is a 1-in-200,000 chance. On exhaustion the code is DESTROYED rather than
 * locked — the requester simply reveals a new one, which costs a tap and denies an attacker
 * the ability to resume where they left off.
 */
const MAX_ATTEMPTS = 5;

/** Bound the endpoint itself as well as the per-code attempts, so a client cannot spread
 *  guesses across freshly-issued codes faster than a human could possibly type them. */
const VERIFY_LIMIT: RateLimit = { capacity: 10, ratePerSec: 0.2 };

const briefSchema = z.object({
  /** What the helper will do. Shown verbatim to the requester, so it is capped and trimmed
   *  rather than free-form — this is a promise someone will rely on. */
  brief: z.string().trim().min(10, "say what you will do").max(1000),
});

const verifySchema = z.object({
  code: z.string().trim().regex(/^\d{4,8}$/, "enter the code the requester read out"),
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Constant-time digest comparison. The digests are the same length by construction, so the
 *  length check is a guard rather than a branch an attacker can time. */
function digestsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** `randomInt` is CSPRNG-backed. `Math.random()` here would be a genuine defect: a predictable
 *  handoff code is a code an attacker standing outside can produce without being told it. */
function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

/** What each party may see. The helper never receives the code — that is the entire point —
 *  and neither party is shown the hash. */
function handoffView(task: Task, forRole: "requester" | "helper") {
  return {
    taskId: task.id,
    state: task.state,
    serviceBrief: task.serviceBrief,
    briefSubmitted: task.serviceBrief != null,
    handoffVerifiedAt: task.handoffVerifiedAt,
    /** Only meaningful to the requester; the helper's UI shows an entry box instead. */
    codeIssued: forRole === "requester" ? task.handoffOtpHash != null : undefined,
  };
}

export function createHandoffRouter(deps: Deps): Router {
  const router = Router();
  const gate = requireOnboarded({ users: deps.users });

  /** Load the task and establish which side of it the caller is on. Non-participants get 404
   *  rather than 403: whether a given task id exists is not their business, and a 403 would
   *  confirm it. */
  async function participant(
    req: AuthedRequest,
    res: Response,
  ): Promise<{ task: Task; role: "requester" | "helper" } | null> {
    const task = await deps.tasks.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task-not-found" });
      return null;
    }
    const userId = req.user!.sub;
    if (task.requesterId === userId) return { task, role: "requester" };
    if (task.helperId === userId) return { task, role: "helper" };
    res.status(404).json({ error: "task-not-found" });
    return null;
  }

  /** Push the new state to both parties so the requester's screen advances the instant the
   *  helper's code is accepted, rather than on their next poll. */
  function broadcast(task: Task): void {
    try {
      const nsp = deps.io.of(NS.matching);
      // Stripped, like every other client-facing path. Both of this function's callers happen
      // to run when the hash is already null — the brief precedes the code, and verification
      // clears it — but that is a property of today's call sites, not of the broadcast, and
      // it is not a thing to leave a future caller to rediscover.
      const forClients = publicTask(task);
      nsp.to(`user:${task.requesterId}`).emit("task-updated", { task: forClients });
      if (task.helperId) {
        nsp.to(`user:${task.helperId}`).emit("task-updated", { task: forClients });
      }
    } catch (err) {
      // A broadcast failure must not fail the request: the state change is already committed
      // and both clients resync from /snapshot on reconnect.
      deps.logger.warn("handoff broadcast failed", { taskId: task.id, err: String(err) });
    }
  }

  // ── 1. the helper's brief ──────────────────────────────────────────────────
  router.post(
    "/tasks/:id/handoff/brief",
    requireAuth,
    gate,
    validateBody(briefSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const found = await participant(req, res);
      if (!found) return;
      if (found.role !== "helper") {
        res.status(403).json({ error: "helper-only" });
        return;
      }
      // Only at the door. Earlier than `arrived` the brief would describe a visit that has not
      // happened; later, the work has already started and a brief is no longer a choice the
      // requester gets to make.
      if (found.task.state !== "arrived") {
        res.status(409).json({ error: "not-at-handoff", state: found.task.state });
        return;
      }
      const { brief } = req.body as z.infer<typeof briefSchema>;
      const updated = await deps.tasks.update(found.task.id, {
        serviceBrief: brief,
        updatedAt: deps.now(),
      });
      broadcast(updated);
      res.json(handoffView(updated, "helper"));
    }),
  );

  // ── 2. the requester reveals a code ────────────────────────────────────────
  router.post(
    "/tasks/:id/handoff/code",
    requireAuth,
    gate,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const found = await participant(req, res);
      if (!found) return;
      if (found.role !== "requester") {
        res.status(403).json({ error: "requester-only" });
        return;
      }
      if (found.task.state !== "arrived") {
        res.status(409).json({ error: "not-at-handoff", state: found.task.state });
        return;
      }
      // The brief is a precondition, not a suggestion. The code means "I have read what you
      // will do and I consent"; issuing one before there is anything to read would reduce the
      // whole exchange to a formality.
      if (!found.task.serviceBrief) {
        res.status(409).json({ error: "brief-required" });
        return;
      }

      const code = generateCode();
      const expiresAt = deps.now() + CODE_TTL_MS;
      await deps.tasks.update(found.task.id, {
        handoffOtpHash: sha256(code),
        handoffOtpExpiresAt: expiresAt,
        updatedAt: deps.now(),
      });
      // Attempts are tracked in Redis rather than a column: the counter is short-lived, and
      // this keeps a hot write path off the tasks table.
      await deps.redis.client.del(keys.handoffAttempts(found.task.id));

      // The ONLY time the plaintext leaves the server, and only to the requester. Re-issuing
      // replaces the previous hash, so an old code stops working the moment a new one is read.
      res.json({ code, expiresAt });
    }),
  );

  // ── 3. the helper enters it ────────────────────────────────────────────────
  router.post(
    "/tasks/:id/handoff/verify",
    requireAuth,
    gate,
    validateBody(verifySchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const found = await participant(req, res);
      if (!found) return;
      if (found.role !== "helper") {
        res.status(403).json({ error: "helper-only" });
        return;
      }
      const { task } = found;

      const allowed = await consumeToken(
        deps.redis.client,
        keys.bucket("handoff-verify", req.user!.sub),
        VERIFY_LIMIT,
        deps.now(),
      );
      if (!allowed) {
        res.status(429).json({ error: "too-many-attempts" });
        return;
      }

      if (task.state !== "arrived") {
        res.status(409).json({ error: "not-at-handoff", state: task.state });
        return;
      }
      if (!task.handoffOtpHash || !task.handoffOtpExpiresAt) {
        res.status(409).json({ error: "no-code-issued" });
        return;
      }
      if (task.handoffOtpExpiresAt <= deps.now()) {
        res.status(410).json({ error: "code-expired" });
        return;
      }

      const { code } = req.body as z.infer<typeof verifySchema>;
      if (!digestsMatch(task.handoffOtpHash, sha256(code))) {
        const attempts = await deps.redis.client.incr(keys.handoffAttempts(task.id));
        await deps.redis.client.pexpire(keys.handoffAttempts(task.id), CODE_TTL_MS);
        if (attempts >= MAX_ATTEMPTS) {
          // Burn the code rather than locking the task. The requester reveals a new one with
          // one tap; an attacker loses everything they had narrowed down.
          await deps.tasks.update(task.id, {
            handoffOtpHash: null,
            handoffOtpExpiresAt: null,
            updatedAt: deps.now(),
          });
          deps.logger.warn("handoff code burned after repeated failures", { taskId: task.id });

          // The strongest signal this system produces. The code is spoken aloud by the
          // requester to the person standing in front of them, so five failures means the
          // person at the door and the person holding the phone are not talking to each
          // other — which is either a helper at the wrong address or somebody who should not
          // be there. Against the HELPER, who is the one entering codes.
          await emitSignal(deps.abuse, "handoff.code_burned", req.user!.sub, deps.now(), {
            taskId: task.id,
            metadata: { attempts },
          });

          res.status(429).json({ error: "too-many-attempts", codeBurned: true });
          return;
        }
        res.status(401).json({ error: "code-invalid", attemptsRemaining: MAX_ATTEMPTS - attempts });
        return;
      }

      // Correct. Clear the credential in the same write that advances the state, so a replay
      // of this exact request finds no code rather than re-running the transition.
      const updated = await deps.tasks.update(task.id, {
        state: "in-progress",
        handoffOtpHash: null,
        handoffOtpExpiresAt: null,
        handoffVerifiedAt: deps.now(),
        updatedAt: deps.now(),
      });
      broadcast(updated);
      res.json(handoffView(updated, "helper"));
    }),
  );

  // ── status, for either party ───────────────────────────────────────────────
  router.get(
    "/tasks/:id/handoff",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const found = await participant(req, res);
      if (!found) return;
      res.json(handoffView(found.task, found.role));
    }),
  );

  return router;
}
