import type { DefaultEventsMap, Namespace } from "socket.io";
import { nanoid } from "nanoid";
import {
  AVAILABILITY_TTL_MS,
  canActorTransition,
  canTransition,
  HELPER_SHARE_PERCENT,
  BOOKING_CONFIRM_BY_MS,
  BOOKING_DISPATCH_LEAD_MS,
  DIRECT_OFFER_WINDOW_MS,
  isAwaitingNamedHelper,
  isLiveDispatchable,
  isTerminal,
  NS,
  pairingDecision,
  publicTask,
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
import { emitSignal } from "../domain/abuseStore.js";
import type { Deps, NamespaceRegistrar } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import { metrics } from "../metrics/appMetrics.js";
import { freshHelperIds, getTaskLocation, removeHelperGeo } from "../domain/location-store.js";
import { clearTaskLocation } from "../domain/location-store.js";
import { readPresence } from "../domain/presence-store.js";
import { computeEta } from "../services/eta.js";
import { pushService } from "../services/push.js";
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

/**
 * Lifetime of the wave marker.
 *
 * It must comfortably outlive the ENTIRE escalation ladder, not one window. If it expires
 * mid-search the next lapse reads "no wave recorded", treats that as wave 0, and escalates to
 * wave 1 again — so a long-running search ping-pongs between the two innermost rings and never
 * reaches the 10 km cap. Nothing errors; the requester simply never sees the wider search.
 *
 * It IS refreshed at every escalation, so this is really a bound on the gap between two
 * lapses, but sizing it to the whole ladder plus the audience grace costs nothing (the key is
 * a single integer, and both `accept` and the final close delete it explicitly) and removes
 * the failure mode rather than making it merely unlikely.
 */
function waveKeyTtlMs(deps: Deps): number {
  const waves = deps.config.match.radiusWavesMeters.length;
  return deps.config.match.offerWindowMs * (waves + 2) + OFFER_AUDIENCE_GRACE_MS;
}

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
        if (task.state !== "searching") return ack({ ok: false, error: "task-not-searching" });
        if (task.requesterId !== requesterId) return ack({ ok: false, error: "not-requester" });

        // ── an assigned booking is NOT a search ──────────────────────────────
        //
        // A task created with a `helperId` is a booking for one specific person — which, in
        // practice, means a restricted pairing that a human approved after watching two video
        // testimonies. Broadcasting it would offer that booking to every eligible helper
        // within the ring and hand it to whoever tapped first, replacing the one person the
        // exception was granted for. The approval is per ordered pair; a stranger who wins the
        // race is not covered by it.
        //
        // `POST /tasks` already carried a comment claiming that assigning the helper "is what
        // stops the search fanning it out to strangers" — and nothing here enforced it. The
        // task went out to the neighbourhood like any other.
        if (task.helperId != null) {
          emitSocketError(socket, {
            event: "request-help",
            code: "NOT_AUTHORIZED",
            message: "this booking is already assigned to a specific helper",
            taskId,
          });
          return ack({ ok: false, error: "task-already-assigned" });
        }

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
        const claimed = await client.zadd(keys.offerExpiryQueue(), "NX", expiresAt, taskId);
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

        // Wave 0 — the innermost ring. `broadcastWave` handles the audience bookkeeping,
        // the fan-out and the "nobody there" release; escalation reuses it unchanged.
        await client.set(keys.offerWave(taskId), "0", "PX", waveKeyTtlMs(deps));
        await broadcastWave(deps, nsp, task, 0, expiresAt);

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

        const outcome = await withLock(client, keys.matchLock(taskId), token, async () => {
          // ── DOUBLE-ACCEPT GUARD ──────────────────────────────────────────
          // Reload under the lock and re-check: if a helper is already assigned or
          // the task has left "searching", this acceptance loses. This re-read is the
          // whole point of the lock — a stale in-flight accept must NOT overwrite a
          // match that another helper already won.
          const task = await deps.tasks.get(taskId);
          if (!task) return { won: false as const, reason: "expired" as const };
          // A DIRECT offer (a booking, or "ask the same person again") already carries its
          // helper: it is acceptable by that one person and nobody else. An open search must
          // still be unassigned.
          const direct = task.helperId != null;
          if (task.state !== "searching" || (direct && task.helperId !== helperId))
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
          const offered = await client.sismember(keys.offerAudience(taskId), helperId);
          if (offered !== 1) return { won: false as const, reason: "expired" as const };

          // 3. The distance cap, re-checked at accept time rather than trusted from the
          //    offer. The audience is cumulative across escalation waves and lives a little
          //    past each window, so membership alone no longer implies "currently within
          //    range" — and a helper who has driven away since being offered must not be
          //    able to take a job they can no longer reach. 10 km is a hard ceiling: no
          //    wave, and no amount of waiting, makes a further helper acceptable.
          //    Not for a direct offer: the requester chose this person by name, and a booking
          //    is confirmed hours ahead, from wherever the helper happens to be.
          const distanceMeters = direct ? null : await helperDistanceTo(deps, helperId, task);
          if (distanceMeters != null && distanceMeters > deps.config.match.radiusMeters) {
            deps.logger.warn("matching accept refused — helper beyond the radius cap", {
              taskId,
              helperId,
              distanceMeters,
            });
            return { won: false as const, reason: "expired" as const };
          }

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
        });

        // withLock returns null when the lock is held elsewhere — another accept is mid
        // -flight, so from this helper's perspective the task is already being taken.
        const settled = outcome ?? { won: false as const, reason: "already-taken" as const };

        if (!settled.won) {
          return ack({ won: false, reason: settled.reason });
        }

        ack({ won: true, task: publicTask(settled.task) });

        // Reveal the match to both parties.
        nsp
          .to(personalRoom(settled.task.requesterId))
          .to(personalRoom(helperId))
          .emit("matched", { task: publicTask(settled.task), helper: settled.helper });
        // The requester may well have closed the page after asking — "you can close this page"
        // is what the search screen tells them.
        void pushService().send(settled.task.requesterId, {
          kind: "matched",
          taskId: settled.task.id,
          helperName: settled.helper.displayName,
        });

        // The search is over: drop the durable expiry entry so the sweep has nothing left to
        // do for this task. `expireOffer` re-checks task state anyway, so a sweep that raced
        // us here is harmless — this just keeps the schedule tidy.
        await client.zrem(keys.offerExpiryQueue(), taskId);

        // Gracefully close the offer for every OTHER helper who received it.
        const audience = await client.smembers(keys.offerAudience(taskId));
        for (const otherId of audience) {
          if (otherId === helperId) continue;
          nsp.to(personalRoom(otherId)).emit("offer-closed", { taskId, reason: "already-taken" });
        }
        await client.del(keys.offerAudience(taskId));
        await client.del(keys.offerWave(taskId));
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
              return {
                ok: false,
                error: "task-not-found",
                code: "NOT_FOUND",
                message: "no such task",
              };

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
            return { ok: true, task: updated, from: task.state };
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
        // Both go out stripped. A cancellation is reachable from `arrived`, so this path can
        // fire while a handoff code is live — and it is broadcast to the helper.
        const forClients = publicTask(updated);
        ack({ ok: true, task: forClients });

        nsp
          .to(personalRoom(updated.requesterId))
          .to(personalRoom(updated.helperId ?? updated.requesterId))
          .emit("task-updated", { task: forClients });

        // Someone at the door is the one moment a requester most needs to know about.
        if (updated.state === "arrived" && updated.helperId) {
          const profile = await deps.helpers.get(updated.helperId);
          void pushService().send(updated.requesterId, {
            kind: "arrived",
            taskId: updated.id,
            helperName: profile?.displayName ?? "Your helper",
          });
        }

        // Cancelling a search nobody has answered yet is free and completely legitimate —
        // people change their minds. Cancelling AFTER a helper accepted means someone stopped
        // what they were doing, possibly set off, and got nothing. That asymmetry is why the
        // signal keys off `from` rather than off the cancellation itself.
        //
        // Attributed to whoever pulled out, which is not always the requester: a helper who
        // accepts and then cancels has done the more costly version of this.
        if (to === "cancelled" && outcome.from !== "searching") {
          await emitSignal(deps.abuse, "task.cancelled_after_match", userId, deps.now(), {
            taskId,
            metadata: { from: outcome.from, role: taskRoleOf(updated, userId) },
          });
        }

        // `searching -> cancelled` is a LEGAL edge (TASK_TRANSITIONS) and the only one a
        // requester can drive while an offer is still out. `task-updated` reaches the two
        // participants, but the offer audience are not participants — so without this, every
        // helper who was offered the task kept a live card for a request that no longer exists,
        // and the only thing that eventually cleared it was the expiry sweep firing
        // `reason: "expired"` up to a whole window later. `cancelled` is in the `offer-closed`
        // contract precisely for this case and nothing was emitting it.
        // Keyed on where it came FROM: a direct offer has a helperId while still searching,
        // and its one recipient needs the closure just as much as an open search's audience.
        if (updated.state === "cancelled" && outcome.from === "searching") {
          await closeCancelledOffer(deps, nsp, taskId);
        }

        // Location sharing is scoped to the active task (AGENTS.md: "auto-revoke on
        // completion or cancellation"). The helper's last position used to stay readable in
        // Redis for the rest of its four-hour TTL after the task was over; `clearTaskLocation`
        // existed for exactly this and nothing called it.
        if (isTerminal(updated.state)) {
          await clearTaskLocation(client, taskId);
        }

        // Credit the helper their share of the task price on completion.
        if (updated.state === "completed" && updated.helperId != null && updated.price > 0) {
          // Calculate helper share: Math.floor prevents fractional paisa issues
          const helperEarns = Math.floor(updated.price * (HELPER_SHARE_PERCENT / 100));
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
        const helperId = socket.data.user.sub;
        await client.srem(keys.offerAudience(p.taskId), helperId);
        // A direct offer has exactly one possible answerer. Their "no" is the answer, and the
        // requester should hear it now rather than when the window runs out.
        const task = await deps.tasks.get(p.taskId);
        if (task && isAwaitingNamedHelper(task) && task.helperId === helperId) {
          const claimed = await client.zrem(keys.offerExpiryQueue(), p.taskId);
          if (claimed === 1) await closeDirectOffer(deps, nsp, p.taskId, "declined");
        }
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

  // ── booking dispatch ─────────────────────────────────────────────────────────
  // Tasks waiting on a named helper are offered to that helper when they fall due. Durable by
  // construction: the source of truth is the task table, and the claim is the same ZADD NX the
  // open search uses, so several instances sweeping at once dispatch each booking once.
  const dispatch = setInterval(() => {
    void dispatchDueDirectOffers(deps, nsp);
  }, BOOKING_SWEEP_INTERVAL_MS);
  dispatch.unref?.();
};

/** The result of an attempted advance, computed under the match lock and reported outside it
 *  so the socket emit/ack happens after the lock is released. */
type AdvanceOutcome =
  /** `from` is the state read INSIDE the lock, which is the only copy that was actually
   *  transitioned away from. Carried out of the closure because the abuse signal below needs
   *  to distinguish "cancelled while still searching" (ordinary, costs nobody anything) from
   *  "cancelled after a helper committed to travelling" (costs a real person a trip), and
   *  re-reading the task afterwards would report the state it has now, not the one it left. */
  | { ok: true; task: Task; from: TaskState }
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
  radiusMeters: number,
): Promise<{ eligible: Candidate[]; restrictedNearby: number }> {
  // ioredis returns a loosely-typed array; with WITHCOORD + WITHDIST each entry is
  // [member, distString, [lngString, latString]]. Parse defensively.
  const raw = await deps.redis.client.geosearch(
    keys.helperGeo(),
    "FROMLONLAT",
    task.origin.lng,
    task.origin.lat,
    "BYRADIUS",
    // Never wider than the configured cap, whatever wave asked. Belt and braces against a
    // caller computing a radius from an index that has drifted past the end of the array.
    Math.min(radiusMeters, deps.config.match.radiusMeters),
    "m",
    "ASC",
    "WITHCOORD",
    "WITHDIST",
  );

  // The requester's identity facts, read ONCE rather than per candidate. Needed for the
  // eligibility matrix below; without a record we cannot evaluate the rule, and the rule
  // fails closed, so an unknown requester matches nobody.
  const requester = await deps.users.getById(task.requesterId);

  // Redis GEO members have no per-member TTL, so the companion freshness index is what
  // expresses availability decay (audit A1/B9). Intersecting here is what stops us offering
  // work to a phantom whose last publish was days ago.
  const fresh = await freshHelperIds(deps.redis.client, deps.now() - AVAILABILITY_TTL_MS);

  const eligible: Candidate[] = [];
  /** In range and otherwise offerable, refused ONLY by the pairing matrix. Reported back to
   *  the requester as a bare count so the search can say why it found nobody. */
  let restrictedNearby = 0;
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

    // ── the service filter ────────────────────────────────────────────────
    // Offering a hospital escort to someone who only signed up for grocery runs wastes the
    // offer window on a helper who will decline. Hospital is mandatory for every helper, so
    // the emergency path is never narrowed by this.
    if (task.serviceCode && !(await deps.services.helperOffers(member, task.serviceCode))) {
      continue;
    }

    // ── the eligibility matrix ────────────────────────────────────────────
    // The safety rule, enforced where the offer is made rather than where it is accepted.
    // Only an outright `allowed` pairing enters live dispatch: a `requires-exception`
    // pairing is legal only as a scheduled booking once an admin has approved the pair, and
    // that path does not come through here.
    const decision = pairingDecision(requester ?? EMPTY_PARTY, user ?? EMPTY_PARTY, deps.now());
    if (!isLiveDispatchable(decision)) {
      // Counted, not just skipped. `requires-exception` is a pairing that a human could
      // approve; `denied` is one nobody can. Both are invisible to the requester today, and
      // the first is the one they can actually do something about.
      if (decision.kind === "requires-exception") restrictedNearby += 1;
      continue;
    }

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
  eligible.sort((a, b) => a.distanceMeters - b.distanceMeters || b.rating - a.rating);
  return { eligible, restrictedNearby };
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
/** Stand-in for a requester whose record could not be read. Both fields null, so
 *  `pairingDecision` takes its fail-closed branch and denies rather than silently treating
 *  the missing record as unrestricted. */
const EMPTY_PARTY = { dateOfBirth: null, gender: null } as const;

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
/**
 * Great-circle distance in metres between a helper's current position and a task's origin,
 * or null if the position is unknown.
 *
 * Asked via GEODIST against the same index the offer came from, so it answers with whatever
 * Redis believes *now* rather than what it believed when the offer went out.
 *
 * Returns null — not Infinity — when the position is unavailable, and the caller treats null
 * as "cannot judge, allow". That is the deliberate direction: the audience check has already
 * established this helper was legitimately offered the task, and refusing a won match because
 * a GEO read blipped would strand a requester who has been told help is coming. The cap is a
 * guard against a stale audience, not the primary authorization.
 */
async function helperDistanceTo(deps: Deps, helperId: string, task: Task): Promise<number | null> {
  try {
    const point = await readAvailabilityPoint(deps, helperId);
    if (!point) return null;
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(task.origin.lat - point.lat);
    const dLng = toRad(task.origin.lng - point.lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(point.lat)) * Math.cos(toRad(task.origin.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  } catch {
    return null;
  }
}

async function readAvailabilityPoint(deps: Deps, helperId: string): Promise<LatLng | null> {
  try {
    const res = (await deps.redis.client.geopos(keys.helperGeo(), helperId)) as
      (string[] | null)[] | null;
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
async function sweepExpiredOffers(deps: Deps, nsp: MatchingNamespace): Promise<void> {
  try {
    const due = await deps.redis.client.zrangebyscore(keys.offerExpiryQueue(), "-inf", deps.now());
    for (const taskId of due) {
      await closeExpiredOffer(deps, nsp, taskId);
    }
    metrics.recordSweep("matching_offer_expiry", true, deps.now());
  } catch (err) {
    // Counted as well as logged: a sweep that fails every second is a stream of identical log
    // lines nobody pages on, and the SweepFailing alert reads this counter.
    metrics.recordSweep("matching_offer_expiry", false, deps.now());
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
      nsp.to(personalRoom(helperId)).emit("offer-closed", { taskId, reason: "cancelled" });
    }
    await deps.redis.client.del(keys.offerAudience(taskId));
  } catch (err) {
    deps.logger.error("matching cancelled-offer close failed", {
      taskId,
      err: String(err),
    });
  }
}

/**
 * Offer a task to everyone eligible within wave `waveIndex`'s radius.
 *
 * Shared by the initial search and every escalation, so the two cannot drift — the audience
 * bookkeeping, the simultaneous fan-out and the "nobody there" release are stated once.
 *
 * Re-emits to the WHOLE ring, including helpers already offered in a narrower wave, rather
 * than only to the newly reachable ones. Their card would otherwise still be showing the
 * previous wave's `expiresAt` and would look dead while the offer is in fact still live.
 * Emitting the same `taskId` again is an update, not a duplicate.
 *
 * Returns how many helpers were reached, so the caller can decide whether to keep going.
 */
async function broadcastWave(
  deps: Deps,
  nsp: MatchingNamespace,
  task: Task,
  waveIndex: number,
  expiresAt: number,
): Promise<number> {
  const { client } = deps.redis;
  const waves = deps.config.match.radiusWavesMeters;
  const radiusMeters = waves[Math.min(waveIndex, waves.length - 1)]!;

  const { eligible: candidates, restrictedNearby } = await findEligibleHelpers(
    deps,
    task,
    radiusMeters,
  );

  if (candidates.length === 0) {
    // Nothing to offer in this ring. The caller decides whether a wider one is available;
    // it is NOT this function's job to release the claim, because on wave 0 an empty ring
    // means "try the next ring", not "give up".
    nsp.to(personalRoom(task.requesterId)).emit("helpers-nearby", {
      taskId: task.id,
      count: 0,
      approxPoints: [],
      // The difference between "nobody is around" and "someone is around and we will not
      // introduce you". Both looked identical on the requester's screen until now.
      restrictedNearby,
    });
    return 0;
  }

  // Remember the audience so `offer-closed` can be fanned out later AND so `accept` can
  // verify the acceptor was actually offered this task. Cumulative across waves: a helper
  // offered at 1 km is still a legitimate acceptor once the search has widened.
  await client.sadd(keys.offerAudience(task.id), ...candidates.map((c) => c.helperId));
  await client.pexpire(
    keys.offerAudience(task.id),
    deps.config.match.offerWindowMs + OFFER_AUDIENCE_GRACE_MS,
  );

  // Broadcast to EVERY eligible helper simultaneously — never sequential offers. These
  // emits are synchronous (no awaits between them) so all helpers race fairly.
  for (const c of candidates) {
    const offer: MatchOffer = {
      taskId: task.id,
      category: task.category,
      // APPROXIMATE, both of them. An offer goes to every eligible helper in range, almost
      // all of whom will never take the task — and this used to hand each of them the
      // requester's exact coordinates, while the request form promised "helpers only see a
      // rough area until one of them accepts". The exact origin is in the task returned to
      // the ONE helper whose accept wins. The distance is rounded as well: an exact distance
      // from a known position, together with a 110 m cell, narrows to a doorstep.
      origin: { lat: coarsen(task.origin.lat), lng: coarsen(task.origin.lng) },
      title: task.title,
      distanceMeters: Math.max(100, Math.round(c.distanceMeters / 100) * 100),
      expiresAt,
    };
    nsp.to(personalRoom(c.helperId)).emit("offer", offer);
    // The second copy, for a helper whose page is closed or whose phone is locked. Not awaited:
    // a slow push service must never delay the socket fan-out above, which is the race every
    // helper with the app open is in. Lives exactly as long as the offer window — a push that
    // arrives after the window has closed would be offering something that no longer exists.
    void pushService().send(
      c.helperId,
      {
        kind: "offer",
        taskId: task.id,
        title: task.title,
        distanceMeters: offer.distanceMeters,
        expiresAt,
      },
      { ttlSeconds: Math.max(1, (expiresAt - deps.now()) / 1000) },
    );
  }

  // Tell the requester how many helpers we reached, with coarsened pins.
  nsp.to(personalRoom(task.requesterId)).emit("helpers-nearby", {
    taskId: task.id,
    count: candidates.length,
    approxPoints: candidates.map((c) => ({
      lat: coarsen(c.point.lat),
      lng: coarsen(c.point.lng),
    })),
    restrictedNearby,
  });

  return candidates.length;
}

/**
 * Fired when an offer window lapses.
 *
 * Two outcomes, and choosing between them is the whole of the escalation logic:
 *
 *  - There is a wider ring left → widen and re-arm. The requester keeps waiting on a search
 *    that is now looking further out; nobody is told the offer closed, because it hasn't.
 *  - The outermost ring has lapsed → close for real, tell the audience, clear the state.
 *
 * The re-arm re-enters the durable schedule (ZADD), so escalation survives a restart exactly
 * as the original expiry does. A no-longer-searching task takes the close path regardless,
 * which is what stops a matched or cancelled task escalating forever.
 */
async function expireOffer(deps: Deps, nsp: MatchingNamespace, taskId: string): Promise<void> {
  const { client } = deps.redis;
  try {
    const task = await deps.tasks.get(taskId);
    // A direct offer never widens — it was only ever for one person. Its lapse is a "no".
    if (task && isAwaitingNamedHelper(task)) {
      await closeDirectOffer(deps, nsp, taskId, "expired");
      return;
    }
    const stillSearching = Boolean(task && task.helperId == null && task.state === "searching");

    if (task && stillSearching) {
      const waves = deps.config.match.radiusWavesMeters;
      const current = Number((await client.get(keys.offerWave(taskId))) ?? "0");
      const next = (Number.isFinite(current) ? current : 0) + 1;

      if (next < waves.length) {
        const expiresAt = deps.now() + deps.config.match.offerWindowMs;
        // Re-arm BEFORE broadcasting. If the process dies between the two, the sweep finds a
        // scheduled entry and retries the wave; the other order would leave an offer out
        // with nothing scheduled to close it.
        await client.zadd(keys.offerExpiryQueue(), expiresAt, taskId);
        await client.set(keys.offerWave(taskId), String(next), "PX", waveKeyTtlMs(deps));
        const reached = await broadcastWave(deps, nsp, task, next, expiresAt);
        deps.logger.info("matching search widened", {
          taskId,
          wave: next,
          radiusMeters: waves[next],
          reached,
        });
        return;
      }
    }

    // Outermost ring lapsed, or the task is no longer searching: close for real.
    if (task && stillSearching) {
      // End the search on the requester's side too. Closing the offer for the helpers and
      // leaving the task `searching` meant the requester watched a radar over a search that
      // had already stopped, with no way to learn that nobody was coming.
      //
      // Re-read under the same per-task lock `accept` takes, so a helper who wins in the last
      // instant of the window is never overwritten by this.
      const outcome = await withLock(client, keys.matchLock(taskId), nanoid(), async () => {
        const fresh = await deps.tasks.get(taskId);
        if (!fresh || fresh.state !== "searching" || fresh.helperId != null) {
          return { closed: null };
        }
        return {
          closed: await deps.tasks.update(taskId, { state: "unmatched", updatedAt: deps.now() }),
        };
      });
      if (outcome === null) {
        // The lock is held: an accept is mid-flight. Come back shortly rather than closing
        // over it — if that accept fails, the task must not be left searching unscheduled.
        await client.zadd(keys.offerExpiryQueue(), deps.now() + 2_000, taskId);
        return;
      }

      const audience = await client.smembers(keys.offerAudience(taskId));
      for (const helperId of audience) {
        nsp.to(personalRoom(helperId)).emit("offer-closed", { taskId, reason: "expired" });
      }
      if (outcome.closed) {
        nsp
          .to(personalRoom(outcome.closed.requesterId))
          .emit("task-updated", { task: publicTask(outcome.closed) });
        deps.logger.info("matching search ended with no helper", { taskId });
      }
    }
    await client.del(keys.offerAudience(taskId));
    await client.del(keys.offerWave(taskId));
  } catch (err) {
    deps.logger.error("matching offer expiry failed", {
      taskId,
      err: String(err),
    });
  }
}

// ── direct offers: bookings and "ask the same person again" ────────────────────

/** How often due bookings are looked for. An unscheduled "ask again" therefore reaches its
 *  helper within this long of being created. */
const BOOKING_SWEEP_INTERVAL_MS = 5_000;

/** Find every task waiting on a named helper that is due, and offer each one. */
export async function dispatchDueDirectOffers(deps: Deps, nsp: MatchingNamespace): Promise<void> {
  try {
    const due = await deps.tasks.awaitingNamedHelper(deps.now() + BOOKING_DISPATCH_LEAD_MS);
    for (const task of due) await dispatchDirectOffer(deps, nsp, task);
    metrics.recordSweep("booking_dispatch", true, deps.now());
  } catch (err) {
    metrics.recordSweep("booking_dispatch", false, deps.now());
    deps.logger.error("booking dispatch sweep failed", { err: String(err) });
  }
}

/**
 * Offer one task to its named helper, at most once per open window.
 *
 * The pairing is RE-CHECKED here rather than trusted from creation time. A booking can be made
 * up to weeks ahead, and in that time the helper can lose their verification, be blocked, or
 * the exception that permitted the pairing can expire. Offering it anyway would put two people
 * together on the strength of a decision that no longer holds.
 */
async function dispatchDirectOffer(deps: Deps, nsp: MatchingNamespace, task: Task): Promise<void> {
  const { client } = deps.redis;
  const helperId = task.helperId;
  if (!helperId || !isAwaitingNamedHelper(task)) return;
  const now = deps.now();

  // Bookings must be answered with time to spare; an unscheduled ask gets a fixed window.
  const window =
    task.scheduledFor == null
      ? DIRECT_OFFER_WINDOW_MS
      : Math.max(DIRECT_OFFER_WINDOW_MS, task.scheduledFor - BOOKING_CONFIRM_BY_MS - now);
  const expiresAt = now + window;

  // The claim. Returns 0 while an offer for this task is live (or lapsed and about to be
  // closed by the expiry sweep), which is what keeps a 5-second sweep from re-offering.
  const claimed = await client.zadd(keys.offerExpiryQueue(), "NX", expiresAt, task.id);
  if (claimed === 0) return;

  // A booking whose start has already passed — the server was down, or it was made before
  // dispatch existed — is not offered at all. Asking someone to confirm a slot that is over
  // would be a nonsense card on their screen; the requester is told it did not happen.
  const missed = task.scheduledFor != null && task.scheduledFor <= now;
  if (missed || !(await namedPairingStillHolds(deps, task, helperId, now))) {
    await client.zrem(keys.offerExpiryQueue(), task.id);
    await closeDirectOffer(deps, nsp, task.id, missed ? "missed" : "no-longer-eligible");
    return;
  }

  await client.sadd(keys.offerAudience(task.id), helperId);
  await client.pexpire(keys.offerAudience(task.id), window + OFFER_AUDIENCE_GRACE_MS);

  const distanceMeters = await helperDistanceTo(deps, helperId, task);
  const offer: MatchOffer = {
    taskId: task.id,
    category: task.category,
    // Coarse, exactly as for an open search: the exact door goes only to an accepted helper.
    origin: { lat: coarsen(task.origin.lat), lng: coarsen(task.origin.lng) },
    title: task.title,
    distanceMeters:
      distanceMeters == null ? null : Math.max(100, Math.round(distanceMeters / 100) * 100),
    expiresAt,
    direct: true,
    scheduledFor: task.scheduledFor,
  };
  nsp.to(personalRoom(helperId)).emit("offer", offer);
  void pushService().send(
    helperId,
    {
      kind: "offer",
      taskId: task.id,
      title: task.title,
      distanceMeters: offer.distanceMeters,
      expiresAt,
      direct: true,
      scheduledFor: task.scheduledFor,
    },
    { ttlSeconds: Math.max(1, window / 1000) },
  );
  deps.logger.info("direct offer sent", {
    taskId: task.id,
    scheduled: task.scheduledFor != null,
    windowMs: window,
  });
}

/** Same rules as creation (router `POST /tasks`) and as an open search's candidate filter. */
async function namedPairingStillHolds(
  deps: Deps,
  task: Task,
  helperId: string,
  now: number,
): Promise<boolean> {
  const [requester, helper] = await Promise.all([
    deps.users.getById(task.requesterId),
    deps.users.getById(helperId),
  ]);
  if (!isOfferableHelper(helper) || helper?.blockedAt != null) return false;
  if (task.serviceCode && !(await deps.services.helperOffers(helperId, task.serviceCode))) {
    return false;
  }
  const decision = pairingDecision(requester ?? EMPTY_PARTY, helper ?? EMPTY_PARTY, now);
  if (decision.kind === "denied") return false;
  if (decision.kind === "requires-exception") {
    return deps.exceptions.isApproved(task.requesterId, helperId, now);
  }
  return true;
}

/**
 * End a direct offer without a match: the helper said no, did not answer in time, or the
 * pairing no longer holds. The caller has already claimed the schedule entry, so this runs
 * once per offer.
 *
 * The task becomes `unmatched` — the same honest end state as a search nobody answered — and
 * the requester is told on screen and by push, because a booking that silently did not happen
 * is someone waiting by a door for nobody.
 */
async function closeDirectOffer(
  deps: Deps,
  nsp: MatchingNamespace,
  taskId: string,
  why: "declined" | "expired" | "no-longer-eligible" | "missed",
): Promise<void> {
  const { client } = deps.redis;
  try {
    const outcome = await withLock(client, keys.matchLock(taskId), nanoid(), async () => {
      const fresh = await deps.tasks.get(taskId);
      if (!fresh || !isAwaitingNamedHelper(fresh)) return { closed: null };
      return {
        closed: await deps.tasks.update(taskId, { state: "unmatched", updatedAt: deps.now() }),
      };
    });
    if (outcome === null) {
      // An accept holds the lock right now. Re-check shortly instead of closing over it.
      await client.zadd(keys.offerExpiryQueue(), deps.now() + 2_000, taskId);
      return;
    }
    const closed = outcome.closed;
    if (closed?.helperId) {
      // Only a helper who actually holds an offer card needs telling it is gone.
      if (why === "expired") {
        nsp.to(personalRoom(closed.helperId)).emit("offer-closed", { taskId, reason: "expired" });
      }
      nsp.to(personalRoom(closed.requesterId)).emit("task-updated", { task: publicTask(closed) });
      const profile = await deps.helpers.get(closed.helperId);
      void pushService().send(closed.requesterId, {
        kind: "unconfirmed",
        taskId,
        helperName: profile?.displayName ?? "The person you asked for",
      });
      deps.logger.info("direct offer ended without a match", { taskId, why });
    }
    await client.del(keys.offerAudience(taskId));
  } catch (err) {
    deps.logger.error("closing direct offer failed", { taskId, why, err: String(err) });
  }
}
