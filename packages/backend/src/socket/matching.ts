import type { DefaultEventsMap, Namespace } from "socket.io";
import {
  canTransition,
  NS,
  type LatLng,
  type MatchedHelper,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type MatchOffer,
} from "@needy/shared";
import type { Deps, NamespaceRegistrar } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import { getTaskLocation } from "../domain/location-store.js";
import { readPresence } from "../domain/presence-store.js";
import { computeEta } from "../services/eta.js";
import { withLock } from "../services/lock.js";
import type { SocketData } from "./auth.js";

/** The /matching namespace (§2.4): broadcast an offer to every eligible nearby helper
 *  simultaneously, then settle a first-accept-wins race under a distributed lock. This is
 *  the correctness-critical module — the double-accept guard inside `accept` is the crux. */

type MatchingNamespace = Namespace<
  MatchingClientEvents,
  MatchingServerEvents,
  DefaultEventsMap,
  SocketData
>;

/** One nearby helper surfaced by GEOSEARCH and confirmed `online-available`. */
interface Candidate {
  helperId: string;
  distanceMeters: number;
  point: LatLng;
  /** Reveal-card rating, pulled cheaply for the secondary ranking seam below. */
  rating: number;
}

const personalRoom = (userId: string) => `user:${userId}`;

/** Round a coordinate to ~3 decimals (~110 m) so the requester's "helpers nearby" pins
 *  hint at density without exposing any helper's precise position (privacy, §2.4). */
const coarsen = (n: number): number => Math.round(n * 1000) / 1000;

export const registerMatching: NamespaceRegistrar = (deps: Deps) => {
  const nsp = deps.io.of(NS.matching) as unknown as MatchingNamespace;

  nsp.on("connection", (socket) => {
    // Personal room so we can target a user across their sockets by userId alone.
    socket.join(personalRoom(socket.data.user.sub));

    // ── request-help ────────────────────────────────────────────────────────
    // Requester opens a search; we fan an offer out to all eligible helpers at once.
    socket.on("request-help", async ({ taskId }, ack) => {
      try {
        const task = await deps.tasks.get(taskId);
        if (!task) return ack({ ok: false, error: "task-not-found" });
        if (task.state !== "searching")
          return ack({ ok: false, error: "task-not-searching" });
        if (task.requesterId !== socket.data.user.sub)
          return ack({ ok: false, error: "not-requester" });

        const candidates = await findEligibleHelpers(deps, task.origin);

        // Remember the audience so we can fan `offer-closed` out later. TTL matches the
        // offer window so a crashed server can't leave the set lingering.
        if (candidates.length > 0) {
          await deps.redis.client.sadd(
            keys.offerAudience(taskId),
            ...candidates.map((c) => c.helperId),
          );
          await deps.redis.client.pexpire(
            keys.offerAudience(taskId),
            deps.config.match.offerWindowMs,
          );
        }

        const expiresAt = deps.now() + deps.config.match.offerWindowMs;

        // Broadcast to EVERY eligible helper simultaneously — never sequential offers.
        // These emits are synchronous (no awaits between them) so all helpers race fairly.
        for (const c of candidates) {
          const offer: MatchOffer = {
            taskId: task.id,
            category: task.category,
            origin: task.origin,
            title: task.title,
            distanceMeters: c.distanceMeters,
            expiresAt,
          };
          nsp.to(personalRoom(c.helperId)).emit("offer", offer);
        }

        // Tell the requester how many helpers we reached, with coarsened pins.
        nsp.to(personalRoom(task.requesterId)).emit("helpers-nearby", {
          taskId: task.id,
          count: candidates.length,
          approxPoints: candidates.map((c) => ({
            lat: coarsen(c.point.lat),
            lng: coarsen(c.point.lng),
          })),
        });

        // Close the offer when the window lapses IF nobody has accepted by then. A winning
        // `accept` flips the task out of "searching", so this fires harmlessly in that case.
        setTimeout(() => {
          void expireOffer(deps, nsp, taskId);
        }, deps.config.match.offerWindowMs);

        ack({ ok: true });
      } catch (err) {
        deps.logger.error("matching request-help failed", {
          taskId,
          err: String(err),
        });
        ack({ ok: false, error: "internal-error" });
      }
    });

    // ── accept ──────────────────────────────────────────────────────────────
    // The race-critical path. Multiple helpers may accept the same offer within
    // milliseconds; exactly one must win.
    socket.on("accept", async ({ taskId }, ack) => {
      const helperId = socket.data.user.sub;
      try {
        // Unique token per attempt so releaseLock only ever deletes OUR lock.
        const token = `${socket.id}:${deps.now()}`;

        const outcome = await withLock(
          deps.redis.client,
          keys.matchLock(taskId),
          token,
          async () => {
            // ── DOUBLE-ACCEPT GUARD ──────────────────────────────────────────
            // Reload under the lock and re-check: if a helper is already assigned or
            // the task has left "searching", this acceptance loses. This re-read is the
            // whole point of the lock — a stale in-flight accept must NOT overwrite a
            // match that another helper already won.
            const task = await deps.tasks.get(taskId);
            if (!task) return { won: false as const, reason: "expired" as const };
            if (task.helperId != null || task.state !== "searching")
              return { won: false as const, reason: "already-taken" as const };

            const updated = await deps.tasks.update(taskId, {
              helperId,
              state: "matched",
              updatedAt: deps.now(),
            });

            const helper = await buildMatchedHelper(deps, helperId, updated.origin);
            return { won: true as const, task: updated, helper };
          },
        );

        // withLock returns null when the lock is held elsewhere — another accept is mid
        // -flight, so from this helper's perspective the task is already being taken.
        const settled = outcome ?? { won: false as const, reason: "already-taken" as const };

        if (!settled.won) {
          return ack({ won: false, reason: settled.reason });
        }

        ack({ won: true, task: settled.task });

        // Reveal the match to both parties.
        nsp
          .to(personalRoom(settled.task.requesterId))
          .to(personalRoom(helperId))
          .emit("matched", { task: settled.task, helper: settled.helper });

        // Gracefully close the offer for every OTHER helper who received it.
        const audience = await deps.redis.client.smembers(keys.offerAudience(taskId));
        for (const otherId of audience) {
          if (otherId === helperId) continue;
          nsp
            .to(personalRoom(otherId))
            .emit("offer-closed", { taskId, reason: "already-taken" });
        }
        await deps.redis.client.del(keys.offerAudience(taskId));
      } catch (err) {
        deps.logger.error("matching accept failed", {
          taskId,
          helperId,
          err: String(err),
        });
        // A failed attempt didn't win; report the race as lost rather than hanging the ack.
        ack({ won: false, reason: "already-taken" });
      }
    });

    // ── advance-task ──────────────────────────────────────────────────────────
    // Drive a matched task through its lifecycle. Enforces the shared TASK_TRANSITIONS
    // state machine + participant auth, then broadcasts `task-updated` to both parties so
    // every client's `task.state` stays server-authoritative (this is what lets the wired
    // Stage 3–7 animations advance live, not just at match).
    socket.on("advance-task", async ({ taskId, to }, ack) => {
      const userId = socket.data.user.sub;
      try {
        const task = await deps.tasks.get(taskId);
        if (!task) return ack({ ok: false, error: "task-not-found" });
        if (task.requesterId !== userId && task.helperId !== userId)
          return ack({ ok: false, error: "not-a-participant" });
        // `matched`/`searching` are owned by the create + accept flows, never a free advance.
        if (to === "matched" || to === "searching")
          return ack({ ok: false, error: "illegal-target" });
        if (!canTransition(task.state, to))
          return ack({ ok: false, error: `illegal-transition:${task.state}->${to}` });

        const updated = await deps.tasks.update(taskId, {
          state: to,
          updatedAt: deps.now(),
        });
        ack({ ok: true, task: updated });

        nsp
          .to(personalRoom(updated.requesterId))
          .to(personalRoom(updated.helperId ?? updated.requesterId))
          .emit("task-updated", { task: updated });
      } catch (err) {
        deps.logger.error("matching advance-task failed", {
          taskId,
          to,
          err: String(err),
        });
        ack({ ok: false, error: "internal-error" });
      }
    });

    // ── decline ───────────────────────────────────────────────────────────────
    // Best-effort: drop this helper from the audience so they get no further fan-out.
    socket.on("decline", async ({ taskId }) => {
      try {
        await deps.redis.client.srem(
          keys.offerAudience(taskId),
          socket.data.user.sub,
        );
      } catch (err) {
        deps.logger.error("matching decline failed", {
          taskId,
          err: String(err),
        });
      }
    });
  });
};

/** GEOSEARCH the helper GEO set around `origin`, then keep only helpers Redis presence
 *  reports as `online-available`. Results come back distance-ascending from Redis. */
async function findEligibleHelpers(
  deps: Deps,
  origin: LatLng,
): Promise<Candidate[]> {
  // ioredis returns a loosely-typed array; with WITHCOORD + WITHDIST each entry is
  // [member, distString, [lngString, latString]]. Parse defensively.
  const raw = await deps.redis.client.geosearch(
    keys.helperGeo(),
    "FROMLONLAT",
    origin.lng,
    origin.lat,
    "BYRADIUS",
    deps.config.match.radiusMeters,
    "m",
    "ASC",
    "WITHCOORD",
    "WITHDIST",
  );

  const eligible: Candidate[] = [];
  for (const entry of raw as unknown[]) {
    if (!Array.isArray(entry)) continue;
    const [member, distStr, coord] = entry as [unknown, unknown, unknown];
    if (typeof member !== "string") continue;
    if (!Array.isArray(coord)) continue;

    const distanceMeters = Number(distStr);
    const lng = Number((coord as unknown[])[0]);
    const lat = Number((coord as unknown[])[1]);
    if (Number.isNaN(distanceMeters) || Number.isNaN(lng) || Number.isNaN(lat)) continue;

    const presence = await readPresence(deps.redis.client, member);
    if (presence?.state !== "online-available") continue;

    const profile = await deps.helpers.get(member);
    eligible.push({
      helperId: member,
      distanceMeters,
      point: { lat, lng },
      rating: profile?.rating ?? 0,
    });
  }

  // Rank primarily by distance ascending. Secondary tiebreak on rating is a deliberate
  // seam: future scoring folds in response-time and volunteer standing (weighted more for
  // "social-service" tasks, §2.4) — extend this comparator, don't scatter the logic.
  eligible.sort(
    (a, b) => a.distanceMeters - b.distanceMeters || b.rating - a.rating,
  );
  return eligible;
}

/** Assemble the reveal card for the winning helper, with an ETA from their live point to
 *  the task origin (null until they've started sharing location). */
async function buildMatchedHelper(
  deps: Deps,
  helperId: string,
  origin: LatLng,
): Promise<MatchedHelper> {
  const profile = await deps.helpers.get(helperId);

  let etaSeconds: number | null = null;
  const live = await getTaskLocation(deps.redis.client, helperId);
  if (live) {
    const eta = await computeEta({ lat: live.lat, lng: live.lng }, origin);
    etaSeconds = eta.etaSeconds;
  }

  if (profile) return { ...profile, etaSeconds };

  // No profile row (unseeded helper): fall back to handshake claims so the reveal still
  // renders something coherent rather than erroring out of a won match.
  return {
    id: helperId,
    displayName: helperId,
    photoUrl: "",
    rating: 0,
    helpedCount: 0,
    etaSeconds,
  };
}

/** Fired when the offer window lapses. If the task is still unmatched, close the offer for
 *  the whole audience and clear the set. No-op once a helper has won the match. */
async function expireOffer(
  deps: Deps,
  nsp: MatchingNamespace,
  taskId: string,
): Promise<void> {
  try {
    const task = await deps.tasks.get(taskId);
    if (task && task.helperId == null && task.state === "searching") {
      const audience = await deps.redis.client.smembers(keys.offerAudience(taskId));
      for (const helperId of audience) {
        nsp
          .to(personalRoom(helperId))
          .emit("offer-closed", { taskId, reason: "expired" });
      }
    }
    await deps.redis.client.del(keys.offerAudience(taskId));
  } catch (err) {
    deps.logger.error("matching offer expiry failed", {
      taskId,
      err: String(err),
    });
  }
}
