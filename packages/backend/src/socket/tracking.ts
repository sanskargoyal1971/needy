import type { Socket } from "socket.io";
import {
  NS,
  TASK_STATES_WITH_LIVE_TRACKING,
  type LocationUpdate,
  type TaskState,
} from "@needy/shared";
import type { Deps, NamespaceRegistrar } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import { removeHelperGeo, setTaskLocation } from "../domain/location-store.js";
import { computeEta } from "../services/eta.js";
import { consumeToken, type RateLimit } from "../services/ratelimit.js";
import { requireLiveParticipant, requireParticipant } from "./guards.js";
import { joinRoom, leaveRoom } from "./rooms.js";
import { emitSocketError, locationSchema, parseOrRefuse, taskIdSchema } from "./validation.js";
import type { SocketData } from "./auth.js";

/** ── /tracking (§2.3) ────────────────────────────────────────────────────────
 *  The task's helper emits `location` every 3–5s while en route; the server stamps,
 *  persists (current position only) and relays `helper-moved` + a recomputed `eta` to
 *  everyone in the task room. Smooth interpolation between these updates is the client's
 *  job, so we relay each update as-is without extra throttling.
 *
 *  Audited and fixed here:
 *   - B7: `location` took `payload.point.lat/lng` straight into `geoadd` and the ETA maths
 *     with NO validation — NaN, ±Infinity, strings and out-of-range coordinates all reached
 *     Redis, where they either corrupt the geo index or throw from deep inside a pipeline.
 *     Every payload is now parsed with the shared zod schemas first.
 *   - Live-tracking state gate: position was accepted in ANY non-terminal state, including
 *     `searching` (before a helper even exists) and `in-progress`. See the comment on
 *     `isTrackable` below.
 *   - C20: `location` was unbounded — the single highest-frequency event in the system had no
 *     rate limit at all.
 *   - A1/B9: this module used to be the only writer of the helper AVAILABILITY geo index,
 *     which conflated two different concerns. See the note at `removeHelperGeo` below. */

/**
 * Rate limit for `location`. The contract cadence is one update every 3–5s (≈0.2–0.33/s), so
 * a sustained 1/s is ~3x headroom for a client that ticks fast or catches up after a stall,
 * while a burst capacity of 12 absorbs a reconnect flush without dropping the first fixes —
 * which are the ones that matter most, since they reposition a stale marker. Anything beyond
 * that is not a phone reporting GPS.
 */
const LOCATION_LIMIT: RateLimit = { capacity: 12, ratePerSec: 1 };

/**
 * States in which a live position is meaningful.
 *
 * DECISION — we take `TASK_STATES_WITH_LIVE_TRACKING` (en-route, arrived) exactly as shared
 * defines it and do NOT additionally permit `matched`/`verifying`, even though a helper may
 * genuinely start moving before the video check completes. Reasons:
 *
 *  1. There is already a correct way to express "I have set off": `matched → en-route` and
 *     `verifying → en-route` are both legal edges in TASK_TRANSITIONS, and `en-route` is
 *     helper-driven in TRANSITION_ACTORS. So the helper who starts walking early loses
 *     nothing — they advance the task, which is what the requester's UI is waiting to be
 *     told. Accepting location in `matched` instead would make `en-route` decorative and
 *     leave the requester watching a marker move under a "verifying identity" heading.
 *  2. Privacy: a continuous precise position stream before identity verification finishes is
 *     exactly the data we should not be emitting, and `verifying` is the state where either
 *     party is most likely to abandon the match.
 *
 * The list lives in `shared` so the frontend gates its map on the same rule; keeping the
 * decision there rather than widening it locally is what stops the two from drifting.
 */
function isTrackable(state: TaskState): boolean {
  return TASK_STATES_WITH_LIVE_TRACKING.includes(state);
}

export const registerTracking: NamespaceRegistrar = (deps: Deps): void => {
  const nsp = deps.io.of(NS.tracking);
  const { client } = deps.redis;

  nsp.on("connection", (socket: Socket) => {
    const { sub: userId } = (socket.data as SocketData).user;
    // Personal room so targeted server-side pushes can reach this user (§ convention).
    void joinRoom(deps, socket, "connection", `user:${userId}`, { userId });

    socket.on("join", async (payload: unknown) => {
      const p = parseOrRefuse(socket, "join", taskIdSchema, payload);
      if (!p) return;
      try {
        // Read-only, so participation (not liveness) is enough: a client re-opening a
        // finished task may still sit in the room. The mutating `location` demands more.
        const participation = await requireParticipant(deps, socket, "join", userId, p.taskId);
        if (!participation) return;
        // Gating on the result matters more here than anywhere: a client that believes it is
        // subscribed to a task room but is not sits watching a map that never moves, with no
        // error and no indication the helper is on their way.
        if (!(await joinRoom(deps, socket, "join", `task:${p.taskId}`, { userId }))) return;
      } catch (err) {
        deps.logger.error("tracking join failed", {
          err: String(err),
          userId,
          taskId: p.taskId,
        });
        emitSocketError(socket, {
          event: "join",
          code: "INTERNAL",
          message: "could not join task tracking",
          taskId: p.taskId,
        });
      }
    });

    socket.on("leave", (payload: unknown) => {
      const p = parseOrRefuse(socket, "leave", taskIdSchema, payload);
      if (!p) return;
      // Leaving only drops this socket from the room; the stored location stays put —
      // clearing it on task terminal state is the http/matching layer's job.
      void leaveRoom(deps, socket, "leave", `task:${p.taskId}`, { userId });
    });

    socket.on("location", async (payload: unknown) => {
      // B7: parse FIRST. Nothing derived from an unvalidated coordinate may reach Redis or
      // the ETA maths, so this precedes every other check.
      const p = parseOrRefuse(socket, "location", locationSchema, payload);
      if (!p) return;
      const { taskId } = p;

      try {
        // Rate limit before the task read so an unauthorized or misbehaving flood is bounded
        // without costing a repository lookup per event (C20).
        const allowed = await consumeToken(
          client,
          keys.bucket("location", userId),
          LOCATION_LIMIT,
          deps.now(),
        );
        if (!allowed) {
          emitSocketError(socket, {
            event: "location",
            code: "RATE_LIMITED",
            message: "location updates too frequent",
            taskId,
          });
          return;
        }

        const participation = await requireLiveParticipant(
          deps,
          socket,
          "location",
          userId,
          taskId,
        );
        if (!participation) return;
        const { task, role } = participation;

        // Only the matched helper may report position for a task. A requester posting their
        // own position here would show up to their own client as the HELPER moving.
        if (role !== "helper") {
          emitSocketError(socket, {
            event: "location",
            code: "NOT_TASK_HELPER",
            message: "only the assigned helper reports position",
            taskId,
          });
          return;
        }

        if (!isTrackable(task.state)) {
          emitSocketError(socket, {
            event: "location",
            code: "NOT_AUTHORIZED",
            message: `live tracking is not active in state ${task.state}`,
            taskId,
          });
          return;
        }

        const update: LocationUpdate = {
          lat: p.point.lat,
          lng: p.point.lng,
          // 360 and 0 are the same bearing; normalise rather than store both (the schema
          // accepts 360 deliberately because clients wrap inconsistently).
          ...(p.heading != null ? { heading: p.heading % 360 } : {}),
          ...(p.speedMps != null ? { speedMps: p.speedMps } : {}),
          at: deps.now(),
        };

        await setTaskLocation(client, task.id, update);

        // ── Availability vs in-task tracking are DIFFERENT concerns (audit A1/B9) ──
        // This handler used to call `upsertHelperGeo`, i.e. every in-task position tick also
        // refreshed the helper's entry in the AVAILABILITY index that matching offers work
        // from. That is wrong twice over: it made "matched to a task" the precondition for
        // being findable (the original deadlock — /presence's `publish-availability` is the
        // idle publisher and the only correct writer), and it kept advertising a helper who
        // is demonstrably busy. Being on a live tracked task is the strongest possible signal
        // that this helper should not be offered more work, so we DE-LIST them here instead.
        // Idempotent (two ZREMs), so re-running it on every tick is fine and also re-asserts
        // the de-listing after a reconnect or a stray availability publish.
        await removeHelperGeo(client, userId);

        const room = `task:${task.id}`;
        nsp.to(room).emit("helper-moved", { taskId: task.id, update });

        const eta = await computeEta(p.point, task.origin);
        nsp.to(room).emit("eta", {
          taskId: task.id,
          etaSeconds: eta.etaSeconds,
          distanceMeters: eta.distanceMeters,
        });
      } catch (err) {
        deps.logger.error("tracking location failed", {
          err: String(err),
          userId,
          taskId,
        });
        emitSocketError(socket, {
          event: "location",
          code: "INTERNAL",
          message: "could not record location",
          taskId,
        });
      }
    });
  });
};
