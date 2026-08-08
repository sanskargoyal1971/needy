import type { DefaultEventsMap, Namespace } from "socket.io";
import {
  AVAILABILITY_TTL_MS,
  canActorTransition,
  canTransition,
  NS,
  taskRoleOf,
  type LatLng,
  type MatchedHelper,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type MatchOffer,
  type SocketErrorPayload,
  type Task,
  type TaskState,
} from "@needy/shared";
import type { User } from "../auth/types.js";
import type { RedisClient } from "../redis.js";
import type { Deps, NamespaceRegistrar } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import {
  freshHelperIds,
  getTaskLocation,
  removeHelperGeo,
} from "../domain/location-store.js";
import { readPresence } from "../domain/presence-store.js";
import { computeEta } from "../services/eta.js";
import { withLock } from "../services/lock.js";
import { consumeToken, type RateLimit } from "../services/ratelimit.js";
import type { SocketData } from "./auth.js";
import { joinRoom } from "./rooms.js";
import {
  advanceTaskSchema,
  emitSocketError,
  optionalAck,
  parseOrRefuse,
  taskIdSchema,
} from "./validation.js";

/** The /matching namespace (§2.4): broadcast an offer to every eligible nearby helper
 *  simultaneously, then settle a first-accept-wins race under a distributed lock. This is
 *  the correctness-critical module — the double-accept guard inside `accept` is the crux.
 *
 *  Audited and fixed here:
 *   - A6: the match-reveal ETA read the WRONG Redis key, so it was null 100% of the time.
 *     See `buildMatchedHelper`.
 *   - B11: `findEligibleHelpers` offered work to the requester themselves and applied no
 *     role/KYC filter whatsoever. See `findEligibleHelpers`.
 *   - B12: `advance-task` had no role differentiation (a requester could unilaterally
 *     declare `arrived`) and was an unlocked read-modify-write. See the handler.
 *   - C19: offer expiry was an in-process `setTimeout`, so a restart stranded the offer
 *     forever and a duplicate `request-help` created competing timers. Expiry is now a
 *     durable Redis schedule, swept, and idempotent per task.
 *   - accept: never checked the offer's `expiresAt` nor that the acceptor was in the
 *     offer audience — a helper who was never offered the task could accept it.
 *   - B7: every payload is now parsed with the shared zod schemas before use. */

type MatchingNamespace = Namespace<
  MatchingClientEvents,
  MatchingServerEvents,
  DefaultEventsMap,
  SocketData
>;

/** One nearby helper surfaced by GEOSEARCH and confirmed eligible (fresh position, presence
 *  `online-available`, helper-capable role, KYC verified — see `findEligibleHelpers`). */
interface Candidate {
  helperId: string;
  distanceMeters: number;
  point: LatLng;
  /** Reveal-card rating, pulled cheaply for the secondary ranking seam below. */
  rating: number;
}

/**
 * How often the durable offer-expiry schedule is swept (C19).
 *
 * The sweep is what makes `offer-closed` *correct*; the in-process timer below only makes it
 * *prompt*. One second is well inside the "did anything happen?" perception window for a
 * requester watching the radar, and the scanned set only ever holds tasks with a live search,
 * so this is a cheap ZRANGEBYSCORE rather than a table scan.
 */
const OFFER_SWEEP_INTERVAL_MS = 1_000;

/**
 * Extra lifetime on the offer-audience set, beyond the offer window itself.
 *
 * The set has two jobs: authorize `accept`, and name the recipients of `offer-closed`. The
 * second one happens AT the window boundary, so a TTL of exactly `offerWindowMs` is a race the
 * closer usually LOSES — Redis had already evicted the set, `expireOffer` read an empty
 * audience, and the fan-out went to nobody. The result was silent and looked like nothing:
 * every helper kept a dead offer card on screen with no closure ever arriving, which is the
 * precise symptom C19 was supposed to end.
 *
 * The grace period must comfortably exceed the sweep interval, since the sweep is the closer
 * that runs LAST (up to OFFER_SWEEP_INTERVAL_MS after the window lapses) and must still find
 * the audience. It is not a correctness risk in the other direction: `accept` re-checks the
 * durable expiry score, so a lingering set cannot make a lapsed offer acceptable.
 */
const OFFER_AUDIENCE_GRACE_MS = OFFER_SWEEP_INTERVAL_MS * 3;

/** Rate limits (audit C20 — only chat was bounded before, so `request-help` and `accept`
 *  were both unlimited). Sized so a real human never notices: a requester who retries a
 *  search a few times in a row is normal, a client looping `request-help` is not. */
const REQUEST_HELP_LIMIT: RateLimit = { capacity: 10, ratePerSec: 0.5 };
/** Accepts are one-per-offer for a real client; the burst absorbs a double-tap plus the
 *  reconnect flush that follows a dropped ack. */
const ACCEPT_LIMIT: RateLimit = { capacity: 20, ratePerSec: 1 };

const personalRoom = (userId: string) => `user:${userId}`;

/** Round a coordinate to ~3 decimals (~110 m) so the requester's "helpers nearby" pins
 *  hint at density without exposing any helper's precise position (privacy, §2.4). */
const coarsen = (n: number): number => Math.round(n * 1000) / 1000;

export const registerMatching: NamespaceRegistrar = (deps: Deps) => {
  const nsp = deps.io.of(NS.matching) as unknown as MatchingNamespace;
  const { client } = deps.redis;

  nsp.on("connection", (socket) => {
    // Personal room so we can target a user across their sockets by userId alone. Under the
    // Redis adapter `join` is async and can reject, which would silently leave this socket out
    // of the room that carries every `offer`, `matched` and `offer-closed` — so it goes through
    // `joinRoom`, which reports the failure to the client instead of swallowing it.
    void joinRoom(deps, socket, "connection", personalRoom(socket.data.user.sub), {
      userId: socket.data.user.sub,
    });

    // ── request-help ────────────────────────────────────────────────────────
    // Requester opens a search; we fan an offer out to all eligible helpers at once.
    socket.on("request-help", async (payload, rawAck) => {
      // The wire may deliver no callback at all (see `optionalAck`): calling it then throws
      // MID-HANDLER, after the offer has already been broadcast and the durable expiry claimed
      // but BEFORE `helpers-nearby` and the latency timer — so a raw frame stranded the search.
      const ack = optionalAck(rawAck);
      const p = parseOrRefuse(socket, "request-help", taskIdSchema, payload, ack);
      if (!p) return;
      const { taskId } = p;
      const requesterId = socket.data.user.sub;

      try {
        // Bound the action before the repository read, so a flood costs one Redis call
        // rather than a task lookup + GEOSEARCH each (C20).
        const allowed = await consumeToken(
          client,
          keys.bucket("request-help", requesterId),
          REQUEST_HELP_LIMIT,
          deps.now(),
        );
        if (!allowed) {
          emitSocketError(socket, {
            event: "request-help",
            code: "RATE_LIMITED",
            message: "too many searches; slow down",
            taskId,
          });
          return ack({ ok: false, error: "rate-limited" });
        }

        const task = await deps.tasks.get(taskId);
        if (!task) return ack({ ok: false, error: "task-not-found" });
        if (task.state !== "searching")
          return ack({ ok: false, error: "task-not-searching" });
        if (task.requesterId !== requesterId)
          return ack({ ok: false, error: "not-requester" });

        // ── IDEMPOTENCY (audit C19) ──────────────────────────────────────────
        // A second `request-help` for a task that already has a LIVE offer must not
        // re-broadcast to every helper again. Before this, a duplicate call re-offered the
        // task to the whole neighbourhood and armed a second in-process timer whose audience
        // had already been deleted by the first one.
        //
        // The claim is the ZADD NX itself, not a read-then-write: two duplicate calls racing
        // on different instances would both observe "no live offer" if we checked first.
        // Exactly one gets `1` back and owns the broadcast.
        const expiresAt = deps.now() + deps.config.match.offerWindowMs;
        const claimed = await client.zadd(
          keys.offerExpiryQueue(),
          "NX",
          expiresAt,
          taskId,
        );
        if (claimed === 0) {
          const existing = await client.zscore(keys.offerExpiryQueue(), taskId);
          if (existing != null && Number(existing) > deps.now()) {
            // A live offer is already out for this task. Ack success — the caller's intent
            // ("please find me a helper") is satisfied — but emit nothing. The requester's
            // UI resyncs counts from the REST snapshot, not from a duplicate broadcast.
            return ack({ ok: true });
          }
          // A LAPSED entry the sweep hasn't collected yet (e.g. the process restarted mid
          // -window). Take it over by overwriting the score, then re-offer for real.
          await client.zadd(keys.offerExpiryQueue(), expiresAt, taskId);
        }

        const candidates = await findEligibleHelpers(deps, task);

        // Nobody eligible: release the claim immediately rather than holding the task
        // "searching with a live offer" for the full window. There is no audience to close, so
        // there is nothing for the sweep to do, and a requester whose first sweep found zero
        // helpers should be able to try again as soon as someone comes online — the rate limit
        // above is what bounds that, not an artificial cooldown.
        if (candidates.length === 0) {
          await client.zrem(keys.offerExpiryQueue(), taskId);
        }

        // Remember the audience so we can fan `offer-closed` out later AND so `accept` can
        // verify the acceptor was actually offered this task.
        if (candidates.length > 0) {
          await client.sadd(
            keys.offerAudience(taskId),
            ...candidates.map((c) => c.helperId),
          );
          await client.pexpire(
            keys.offerAudience(taskId),
            deps.config.match.offerWindowMs + OFFER_AUDIENCE_GRACE_MS,
          );
        }

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

        // Best-effort in-process timer purely for LATENCY: it closes the offer the instant
        // the window lapses instead of waiting up to OFFER_SWEEP_INTERVAL_MS. Correctness
        // comes from the durable sweep — this timer may be lost to a restart, may fire on an
        // instance that no longer owns anything, or may be duplicated, and in every one of
        // those cases `closeExpiredOffer`'s ZREM claim makes it a no-op.
        const timer = setTimeout(() => {
          void closeExpiredOffer(deps, nsp, taskId);
        }, deps.config.match.offerWindowMs);
        timer.unref?.();

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
    //
    // NOTE on the refusal vocabulary: the contract only allows "already-taken" | "expired".
    // "already-taken" is reserved for genuinely losing the race; every other refusal (bad
    // payload, rate limit, an offer this helper was never in, a lapsed window) reports
    // "expired", i.e. "there is no offer here for you to take". Widening the union is a
    // shared-contract change, so it is deliberately not done unilaterally here.
    socket.on("accept", async (payload, rawAck) => {
      const helperId = socket.data.user.sub;
      // An ack-less frame is the worst case in this handler: the ack fires AFTER the task has
      // been durably assigned and BEFORE `matched` is emitted, so a throw here won the match
      // for a helper nobody is ever told about — the requester waits forever on a task that is
      // no longer `searching` and the offer audience is never closed.
      const ack = optionalAck(rawAck);
      const refuse = (): void => ack({ won: false, reason: "expired" });
      const p = parseOrRefuse(socket, "accept", taskIdSchema, payload, refuse);
      if (!p) return;
      const { taskId } = p;

      try {
        const allowed = await consumeToken(
          client,
          keys.bucket("accept", helperId),
          ACCEPT_LIMIT,
          deps.now(),
        );
        if (!allowed) {
          emitSocketError(socket, {
            event: "accept",
            code: "RATE_LIMITED",
            message: "too many accepts",
            taskId,
          });
          return refuse();
        }

        // Unique token per attempt so releaseLock only ever deletes OUR lock.
        const token = `${socket.id}:${deps.now()}`;

        const outcome = await withLock(
          client,
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

            // ── OFFER VALIDITY (audit: neither of these was checked) ──────────
            // 1. The window. `expiresAt` was sent to the client and then never enforced
            //    server-side, so an offer could be accepted arbitrarily long after it
            //    lapsed — the requester has given up and moved on by then.
            const expiresAt = await client.zscore(keys.offerExpiryQueue(), taskId);
            if (expiresAt == null || Number(expiresAt) <= deps.now())
              return { won: false as const, reason: "expired" as const };

            // 2. The audience. Nothing tied `accept` to having been OFFERED the task, so any
            //    authenticated user who learned a taskId could accept a stranger's request —
            //    bypassing the radius, presence, role and KYC filters entirely. Rooms and
            //    client-side offer state are not a security boundary; the audience set is.
            const offered = await client.sismember(
              keys.offerAudience(taskId),
              helperId,
            );
            if (offered !== 1)
              return { won: false as const, reason: "expired" as const };

            const updated = await deps.tasks.update(taskId, {
              helperId,
              state: "matched",
              updatedAt: deps.now(),
            });

            // Build the reveal card BEFORE de-listing: it reads the availability position as
            // its ETA fallback (see `buildMatchedHelper`), and that entry is about to go.
            const helper = await buildMatchedHelper(deps, helperId, updated);

            // ── DE-LIST THE WINNER (audit follow-up) ─────────────────────────
            // The winner is now busy and must stop being a candidate. Nothing did this: the
            // only de-list was in /tracking's `location`, which is gated on `en-route`/
            // `arrived` — states a freshly-matched helper has not reached. So between winning
            // and setting off (a verification step, a phone call, a walk to the door — easily
            // minutes) they stayed in `geo:helpers` with a fresh timestamp and could be
            // offered a SECOND task. Accepting it would strand one of the two requesters, and
            // the one who loses is someone already told help is on the way.
            //
            // Done inside the lock, after the write that made them the winner, so a losing
            // concurrent accept can never de-list a helper it did not actually match.
            await removeHelperGeo(client, helperId);

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

        // The search is over: drop the durable expiry entry so the sweep has nothing left to
        // do for this task. `expireOffer` re-checks task state anyway, so a sweep that raced
        // us here is harmless — this just keeps the schedule tidy.
        await client.zrem(keys.offerExpiryQueue(), taskId);

        // Gracefully close the offer for every OTHER helper who received it.
        const audience = await client.smembers(keys.offerAudience(taskId));
        for (const otherId of audience) {
          if (otherId === helperId) continue;
          nsp
            .to(personalRoom(otherId))
            .emit("offer-closed", { taskId, reason: "already-taken" });
        }
        await client.del(keys.offerAudience(taskId));
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
    // Drive a matched task through its lifecycle, then broadcast `task-updated` to both
    // parties so every client's `task.state` stays server-authoritative (this is what lets
    // the wired Stage 3–7 animations advance live, not just at match).
    //
    // AUDIT B12 — two defects, both fixed below:
    //  (a) NO ROLE DIFFERENTIATION. Participation alone was the whole check, so a requester
    //      could unilaterally declare `en-route`, `arrived` and `in-progress` — physical
    //      claims that belong to the person actually moving — and a helper could declare the
    //      task `completed` on their own say-so, closing the tracked/chattable/SOS-capable
    //      window on the vulnerable party. The matrix is `TRANSITION_ACTORS` in @needy/shared
    //      and is imported here rather than restated: a second hand-rolled copy is exactly
    //      how the server and the UI's control gating drift apart.
    //  (b) UNLOCKED READ-MODIFY-WRITE. `accept` takes the match lock and re-reads under it;
    //      this handler read the task, validated, then wrote — so two concurrent advances
    //      (or an advance racing the accept flow) could both validate against the same stale
    //      state and interleave. It now uses the SAME withLock + re-read-inside-the-lock
    //      pattern as the double-accept guard.
    socket.on("advance-task", async (payload, rawAck) => {
      const userId = socket.data.user.sub;
      // Same shape as `accept`: the ack precedes the `task-updated` fan-out, so an ack-less
      // frame committed the state change and told neither party about it.
      const ack = optionalAck(rawAck);

      // `matched`/`searching` are owned by the create + accept flows, never a free advance.
      // Checked BEFORE the schema deliberately: `advanceTaskSchema` already excludes them, so
      // parsing first would report a legitimate-but-never-advanceable TaskState as a generic
      // "invalid-payload" and lose the contract-level reason the client needs to see.
      const requestedTo = (payload as { to?: unknown } | null)?.to;
      if (requestedTo === "matched" || requestedTo === "searching") {
        return ack({ ok: false, error: "illegal-target" });
      }

      const p = parseOrRefuse(socket, "advance-task", advanceTaskSchema, payload, ack);
      if (!p) return;
      const { taskId } = p;
      // The schema's enum is built from ADVANCEABLE_STATES, which is a readonly TaskState[];
      // the zod cast in validation.ts widens it to string, so narrow it back here.
      const to = p.to as TaskState;

      try {
        const token = `${socket.id}:${deps.now()}`;
        const outcome = await withLock<AdvanceOutcome>(
          client,
          keys.matchLock(taskId),
          token,
          async () => {
            // RE-READ INSIDE THE LOCK — everything below validates against this copy, so a
            // transition can never be authorized against state another writer has since
            // replaced (B12b).
            const task = await deps.tasks.get(taskId);
            if (!task)
              return { ok: false, error: "task-not-found", code: "NOT_FOUND", message: "no such task" };

            const role = taskRoleOf(task, userId);
            if (!role)
              return {
                ok: false,
                error: "not-a-participant",
                code: "NOT_A_PARTICIPANT",
                message: "not a participant of this task",
              };

            // Edge legality first, actor second: an illegal edge is illegal for EVERYONE, so
            // reporting it as an authorization failure would mislead a legitimate caller (and
            // would tell them their role is wrong when it isn't).
            if (!canTransition(task.state, to))
              return {
                ok: false,
                error: `illegal-transition:${task.state}->${to}`,
                code: "NOT_AUTHORIZED",
                message: `cannot go ${task.state} -> ${to}`,
              };

            if (!canActorTransition(role, to))
              return {
                ok: false,
                error: `not-allowed-for-role:${role}->${to}`,
                code: "NOT_AUTHORIZED",
                message: `a ${role} may not set ${to}`,
              };

            const updated = await deps.tasks.update(taskId, {
              state: to,
              updatedAt: deps.now(),
            });
            return { ok: true, task: updated };
          },
        );

        // Lock held elsewhere: another advance (or the accept flow) is mid-transition on this
        // very task. Refusing is right — retrying against fresh state is the client's call,
        // and silently proceeding is the interleaving this lock exists to prevent.
        if (outcome == null) {
          emitSocketError(socket, {
            event: "advance-task",
            code: "INTERNAL",
            message: "task is being updated; retry",
            taskId,
          });
          return ack({ ok: false, error: "task-busy" });
        }

        if (!outcome.ok) {
          emitSocketError(socket, {
            event: "advance-task",
            code: outcome.code,
            message: outcome.message,
            taskId,
          });
          return ack({ ok: false, error: outcome.error });
        }

        const updated = outcome.task;
        ack({ ok: true, task: updated });

        nsp
          .to(personalRoom(updated.requesterId))
          .to(personalRoom(updated.helperId ?? updated.requesterId))
          .emit("task-updated", { task: updated });

        // `searching -> cancelled` is a LEGAL edge (TASK_TRANSITIONS) and the only one a
        // requester can drive while an offer is still out. `task-updated` reaches the two
        // participants, but the offer audience are not participants — so without this, every
        // helper who was offered the task kept a live card for a request that no longer exists,
        // and the only thing that eventually cleared it was the expiry sweep firing
        // `reason: "expired"` up to a whole window later. `cancelled` is in the `offer-closed`
        // contract precisely for this case and nothing was emitting it.
        if (updated.state === "cancelled" && updated.helperId == null) {
          await closeCancelledOffer(deps, nsp, taskId);
        }

        // Credit the helper their share of the task price on completion.
        if (updated.state === "completed" && updated.helperId != null && (updated as any).price > 0) {
          // Calculate helper share: Math.floor prevents fractional paisa issues
          const helperEarns = Math.floor((updated as any).price * (80 / 100));
          await deps.helpers.addEarnings(updated.helperId, helperEarns);
        }
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
    // Best-effort: drop this helper from the audience so they get no further fan-out — and,
    // since the audience is now what `accept` authorizes against, so a decline is final.
    socket.on("decline", async (payload) => {
      const p = parseOrRefuse(socket, "decline", taskIdSchema, payload);
      if (!p) return;
      try {
        await client.srem(keys.offerAudience(p.taskId), socket.data.user.sub);
      } catch (err) {
        deps.logger.error("matching decline failed", {
          taskId: p.taskId,
          err: String(err),
        });
      }
    });
  });

  // ── durable offer-expiry sweep (audit C19) ──────────────────────────────────
  // ONE sweep for the whole namespace, never per-socket. Expiry used to live purely in an
  // in-process setTimeout, which meant: a restart mid-window stranded the offer forever (the
  // task sat in `searching` and every helper kept a dead offer card on screen, since nobody
  // ever emitted `offer-closed`), and a duplicate request-help armed a second timer racing
  // the first over an audience set the first had already deleted. The schedule is now a Redis
  // sorted set that survives the process, and each expiry is claimed exactly once.
  const sweep = setInterval(() => {
    void sweepExpiredOffers(deps, nsp);
  }, OFFER_SWEEP_INTERVAL_MS);
  // Don't keep the process alive purely for the sweep.
  sweep.unref?.();
};

/** The result of an attempted advance, computed under the match lock and reported outside it
 *  so the socket emit/ack happens after the lock is released. */
type AdvanceOutcome =
  | { ok: true; task: Task }
  | {
      ok: false;
      error: string;
      code: SocketErrorPayload["code"];
      message: string;
    };

/**
 * GEOSEARCH the helper GEO set around the task origin and keep only helpers who are
 * genuinely offerable. Results come back distance-ascending from Redis.
 *
 * ── AUDIT B11 ───────────────────────────────────────────────────────────────
 * This function used to filter on presence alone, which meant:
 *   - THE REQUESTER WAS OFFERED THEIR OWN TASK. Any requester who also publishes
 *     availability (the `both` role is normal) received their own request, and — before the
 *     audience check in `accept` existed — could accept it, matching themselves and burning
 *     the task.
 *   - NO ROLE OR KYC FILTER AT ALL, despite "helpers can't receive offers until verified"
 *     being the stated rule. Any account with a position in the geo index got work.
 *
 * Eligibility for a CANDIDATE cannot come from a JWT: the only claims we hold are the
 * caller's (the requester here, or the acceptor in `accept`). It is resolved against the
 * durable user record via `deps.users` instead, and fails CLOSED — no record, no offer.
 *
 * Filters are ordered cheapest-first (one set read, then per-candidate lookups) so a large
 * GEOSEARCH result doesn't cost a round-trip per hit for helpers we can rule out for free.
 */
async function findEligibleHelpers(
  deps: Deps,
  task: Task,
): Promise<Candidate[]> {
  // ioredis returns a loosely-typed array; with WITHCOORD + WITHDIST each entry is
  // [member, distString, [lngString, latString]]. Parse defensively.
  const raw = await deps.redis.client.geosearch(
    keys.helperGeo(),
    "FROMLONLAT",
    task.origin.lng,
    task.origin.lat,
    "BYRADIUS",
    deps.config.match.radiusMeters,
    "m",
    "ASC",
    "WITHCOORD",
    "WITHDIST",
  );

  // Redis GEO members have no per-member TTL, so the companion freshness index is what
  // expresses availability decay (audit A1/B9). Intersecting here is what stops us offering
  // work to a phantom whose last publish was days ago.
  const fresh = await freshHelperIds(
    deps.redis.client,
    deps.now() - AVAILABILITY_TTL_MS,
  );

  const eligible: Candidate[] = [];
  for (const entry of raw as unknown[]) {
    if (!Array.isArray(entry)) continue;
    const [member, distStr, coord] = entry as [unknown, unknown, unknown];
    if (typeof member !== "string") continue;
    if (!Array.isArray(coord)) continue;

    // B11: never offer a task to the person who opened it.
    if (member === task.requesterId) continue;
    if (!fresh.has(member)) continue;

    const distanceMeters = Number(distStr);
    const lng = Number((coord as unknown[])[0]);
    const lat = Number((coord as unknown[])[1]);
    if (Number.isNaN(distanceMeters) || Number.isNaN(lng) || Number.isNaN(lat)) continue;

    const presence = await readPresence(deps.redis.client, member);
    if (presence?.state !== "online-available") continue;

    // B11: durable role + KYC gate.
    const user = await deps.users.getById(member);
    if (!isOfferableHelper(user)) continue;

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

/**
 * May this account be offered paid/volunteer work at all (audit B11)?
 *
 * Mirrors `guards.claimsAreVerifiedHelper` but reads the DURABLE user record rather than a
 * JWT, because this question is asked about a candidate, not about the caller. Admins bypass
 * KYC so support staff can operate without a personal eKYC record, exactly as in `guards`.
 *
 * Fails closed on a missing record: an unknown account is not a verified helper.
 */
function isOfferableHelper(user: User | null): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  const canHelp = user.role === "helper" || user.role === "both";
  return canHelp && user.kycStatus === "verified";
}

/**
 * Assemble the reveal card for the winning helper, with an ETA to the task origin.
 *
 * ── AUDIT A6 ────────────────────────────────────────────────────────────────
 * This read `getTaskLocation(redis, helperId)` — but that key builder is
 * `track:loc:<taskId>`, NOT a per-helper key. It therefore looked up a key that is never
 * written by anything, always got null, and `etaSeconds` was null on 100% of match reveals;
 * the UI silently degraded to "on their way" forever and the bug was invisible because null
 * is a legitimate value here. Pass the TASK id, never the helper id.
 *
 * ETA source order, most to least precise:
 *   1. the task's live tracked position (`track:loc:<taskId>`) — only present if this task
 *      somehow already had tracking data, e.g. a re-match after a cancelled helper;
 *   2. the helper's IDLE AVAILABILITY position from the geo index. At match time (1) is
 *      normally absent — /tracking only starts writing once the helper goes `en-route` — but
 *      the position that made this helper a candidate seconds ago is right there in the geo
 *      set, and it is a legitimate, far better answer than null.
 *
 *      This is only sound because it is read at MATCH time, on the one call path that has just
 *      confirmed the position is current: the helper was selected by a GEOSEARCH whose hits are
 *      intersected with the freshness index, so the entry is at most AVAILABILITY_TTL_MS old
 *      and belongs to someone who was idle a moment ago. (An earlier version of this comment
 *      claimed /tracking's de-list guaranteed the entry could never be an in-task one. It does
 *      not: that de-list is gated on `en-route`/`arrived`, so a matched-but-not-yet-moving
 *      helper was still listed. `accept` now de-lists the winner itself — which is a fix for
 *      double-offering, and only incidentally for this.) Do not lift this read onto a path
 *      that has not established freshness;
 *   3. null — we honestly don't know, and the UI says "on their way".
 */
async function buildMatchedHelper(
  deps: Deps,
  helperId: string,
  task: Task,
): Promise<MatchedHelper> {
  const profile = await deps.helpers.get(helperId);

  let etaSeconds: number | null = null;
  const tracked = await getTaskLocation(deps.redis.client, task.id);
  const from = tracked
    ? { lat: tracked.lat, lng: tracked.lng }
    : await readAvailabilityPoint(deps, helperId);
  if (from) {
    const eta = await computeEta(from, task.origin);
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

/** The helper's last published idle availability position, straight from the GEO set that
 *  produced them as a candidate (see the fallback order in `buildMatchedHelper`). Read here
 *  rather than in domain/location-store only because matching is the sole consumer so far —
 *  if a second module needs it, it belongs next to the other GEO accessors.
 *
 *  Never throws: a missing GEOPOS (an unsupported command in a test double, a wiped index)
 *  must degrade the ETA to null, not lose a won match. */
async function readAvailabilityPoint(
  deps: Deps,
  helperId: string,
): Promise<LatLng | null> {
  try {
    const res = (await deps.redis.client.geopos(keys.helperGeo(), helperId)) as
      | (string[] | null)[]
      | null;
    const first = res?.[0];
    if (!first) return null;
    const lng = Number(first[0]);
    const lat = Number(first[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return { lat, lng };
  } catch (err) {
    deps.logger.debug("matching: availability position unavailable for ETA", {
      helperId,
      err: String(err),
    });
    return null;
  }
}

/** Collect every offer whose window has lapsed and close each one. Driven by the interval in
 *  `registerMatching`; the per-task ZREM claim inside `closeExpiredOffer` means running this
 *  on several instances at once (or alongside a stray in-process timer) is safe. */
async function sweepExpiredOffers(
  deps: Deps,
  nsp: MatchingNamespace,
): Promise<void> {
  try {
    const due = await deps.redis.client.zrangebyscore(
      keys.offerExpiryQueue(),
      "-inf",
      deps.now(),
    );
    for (const taskId of due) {
      await closeExpiredOffer(deps, nsp, taskId);
    }
  } catch (err) {
    deps.logger.error("matching offer expiry sweep failed", { err: String(err) });
  }
}

const CLAIM_LAPSED_OFFER_SCRIPT = `
local score = redis.call("zscore", KEYS[1], ARGV[1])
if score and tonumber(score) <= tonumber(ARGV[2]) then
  return redis.call("zrem", KEYS[1], ARGV[1])
else
  return 0
end`;

/**
 * Atomically claim a LAPSED schedule entry: remove it and report true only if it exists AND its
 * window has actually closed. Same shape as the lock's compare-and-del — read and delete in one
 * round trip, because anything split across two is a race by construction.
 *
 * Exactly one caller can get `true` for a given entry, which is what makes offer closure
 * at-most-once across duplicate sweeps, several instances, and the in-process timer.
 *
 * ── WHY THE `score <= now` GUARD, NOT A BARE ZREM ──────────────────────────────
 * A bare ZREM claims whatever entry happens to sit under that taskId — including one belonging
 * to a NEWER, still-live offer for the same task. Two callers can arrive stale:
 *
 *   - `sweepExpiredOffers` is a read-then-act batch: it ZRANGEBYSCOREs everything due, then
 *     awaits a close per task. While it works through that list the entry for a task later in
 *     the batch can be closed and re-requested, so the score it was selected on is no longer
 *     the score in Redis.
 *   - the best-effort in-process timer fires blind one whole window after it was armed, and
 *     event-loop delay can push it past a subsequent re-request of the same task.
 *
 * The damage from claiming a live entry is not cosmetic: `expireOffer` fans `offer-closed` out
 * and DELETES the audience set, and `accept` authorizes against that set — so every helper who
 * had legitimately been offered the task is then refused, mid-window, with "expired".
 *
 * Exported for direct testing: this is the whole of the exactly-once guarantee, and a test that
 * re-implemented the script would be evidence about its own copy rather than about this one.
 */
export async function claimLapsedOffer(
  redis: RedisClient,
  taskId: string,
  now: number,
): Promise<boolean> {
  const claimed = await redis.eval(
    CLAIM_LAPSED_OFFER_SCRIPT,
    1,
    keys.offerExpiryQueue(),
    taskId,
    String(now),
  );
  return Number(claimed) === 1;
}

/**
 * Close a single lapsed offer, AT MOST ONCE per task across the whole cluster.
 *
 * The atomic claim above is what does it: whoever removes the schedule entry (return value 1)
 * does the fan-out, everybody else returns immediately. That is what makes expiry idempotent
 * under a duplicate request-help, several instances sweeping in parallel, and the best-effort
 * in-process timer all firing for the same task (audit C19).
 */
async function closeExpiredOffer(
  deps: Deps,
  nsp: MatchingNamespace,
  taskId: string,
): Promise<void> {
  try {
    if (!(await claimLapsedOffer(deps.redis.client, taskId, deps.now()))) return;
    await expireOffer(deps, nsp, taskId);
  } catch (err) {
    deps.logger.error("matching offer expiry claim failed", {
      taskId,
      err: String(err),
    });
  }
}

/**
 * The requester withdrew a task while its offer was still out. Same claim discipline as
 * `closeExpiredOffer` — the ZREM on the schedule is what makes the fan-out at-most-once, so
 * this racing the sweep (or another instance) closes the offer exactly one way, never both.
 *
 * If the sweep got there first the entry is already gone and the audience already has
 * `reason: "expired"`, which is a slightly worse message but not a wrong one; the point is
 * that nobody gets two closures and nobody gets none.
 *
 * DELIBERATELY a bare ZREM, not `claimLapsedOffer`. The window guard there exists because a
 * lapse-driven closer may be STALE — armed against an older offer for the same task. This
 * caller is not: it runs inline, immediately after the `searching -> cancelled` write it is
 * reacting to, and the offer it must close is by definition the LIVE one whose window has NOT
 * lapsed. Applying the guard here would make cancellation a no-op every time.
 */
async function closeCancelledOffer(
  deps: Deps,
  nsp: MatchingNamespace,
  taskId: string,
): Promise<void> {
  try {
    const claimed = await deps.redis.client.zrem(keys.offerExpiryQueue(), taskId);
    if (claimed !== 1) return;
    const audience = await deps.redis.client.smembers(keys.offerAudience(taskId));
    for (const helperId of audience) {
      nsp
        .to(personalRoom(helperId))
        .emit("offer-closed", { taskId, reason: "cancelled" });
    }
    await deps.redis.client.del(keys.offerAudience(taskId));
  } catch (err) {
    deps.logger.error("matching cancelled-offer close failed", {
      taskId,
      err: String(err),
    });
  }
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
