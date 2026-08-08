import type { Socket } from "socket.io";
import {
  AVAILABILITY_TTL_MS,
  AWAY_AFTER_MS,
  HEARTBEAT_INTERVAL_MS,
  NS,
  type Presence,
} from "@needy/shared";
import type { NamespaceRegistrar } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import {
  removeHelperGeo,
  sweepStaleHelperGeo,
  upsertHelperGeo,
} from "../domain/location-store.js";
import {
  addPresenceSub,
  decrSocketCount,
  incrSocketCount,
  listPresenceSubs,
  patchPresence,
  readPresence,
  removePresenceSub,
} from "../domain/presence-store.js";
import { consumeToken } from "../services/ratelimit.js";
import type { SocketData } from "./auth.js";
import { claimsAreVerifiedHelper } from "./guards.js";
import { joinRoom } from "./rooms.js";
import {
  emitSocketError,
  optionalAck,
  parseOrRefuse,
  publishAvailabilitySchema,
  setActivitySchema,
  subscribeSchema,
} from "./validation.js";

/** /presence namespace (§2.2). Owns the socket wiring, the single away-sweep, the idle
 *  availability index (audit A1) and the per-user socket refcount (audit B10). The Redis hash
 *  shape itself lives in domain/presence-store so matching stays in lockstep. Presence-changed
 *  is fanned out only to a helper's subscribers, never globally. */

/** Availability publishes are frequent by design (the client re-publishes at TTL/3), so the
 *  budget is generous — this only exists to stop a compromised client hammering `geoadd`. */
const AVAILABILITY_LIMIT = { capacity: 20, ratePerSec: 1 };
/** Subscribing is a fan-out registration; a client legitimately does it once per task. */
const SUBSCRIBE_LIMIT = { capacity: 20, ratePerSec: 0.5 };

export const registerPresence: NamespaceRegistrar = (deps) => {
  const nsp = deps.io.of(NS.presence);
  const { client } = deps.redis;

  /** userIds with at least one live socket ON THIS INSTANCE — the away-sweep only scans these
   *  so we never flip already-offline users, and it doubles as the sweep's work set. The
   *  authoritative cross-instance count is the Redis refcount (B10); this is a local work set,
   *  not a source of truth about presence. */
  const connected = new Set<string>();

  /** Fan a presence change out to everyone subscribed to this user (§2.2 scoping). */
  const broadcast = async (presence: Presence): Promise<void> => {
    const subs = await listPresenceSubs(client, presence.userId);
    for (const requesterId of subs) {
      nsp.to("user:" + requesterId).emit("presence-changed", presence);
    }
  };

  nsp.on("connection", (socket: Socket) => {
    const claims = (socket.data as SocketData).user;
    const userId = claims.sub;
    void joinRoom(deps, socket, "connection", "user:" + userId, { userId });
    connected.add(userId);

    void (async () => {
      try {
        await incrSocketCount(client, userId);
        const presence = await patchPresence(client, userId, {
          state: "online-available",
          activity: "idle",
          lastActiveAt: deps.now(),
        });
        await broadcast(presence);
      } catch (err) {
        deps.logger.error("presence: connect init failed", { err, userId });
      }
    })();

    socket.on("heartbeat", () => {
      void (async () => {
        try {
          const current = await readPresence(client, userId);
          // A heartbeat proves the user is back; lift a prior away flip.
          const state =
            current?.state === "away" ? "online-available" : current?.state;
          const presence = await patchPresence(client, userId, {
            lastActiveAt: deps.now(),
            ...(state ? { state } : {}),
          });
          await broadcast(presence);
        } catch (err) {
          deps.logger.error("presence: heartbeat failed", { err, userId });
        }
      })();
    });

    /**
     * ── IDLE AVAILABILITY PUBLISH (audit A1) ─────────────────────────────────
     *
     * THE DEADLOCK THIS BREAKS. Matching finds candidates with GEOSEARCH over
     * `geo:helpers`. Before this handler existed, the *only* writer of that set was
     * /tracking's `location` — an event that requires already being assigned to a task. So
     * to become findable a helper first had to be found. With zero tasks in the system the
     * index was empty, every search returned zero candidates, and no task could ever be
     * matched. The event was declared in shared/events.ts and had no server handler and no
     * client caller; the type existing is what made the gap look filled.
     *
     * WHY IT IS DELIBERATELY NOT THE SAME WRITE AS /tracking. These are two different
     * claims: "I am available around here" versus "I am at this position while doing your
     * task". /tracking now REMOVES the helper from this index on every tick, precisely so a
     * helper on a live task stops being offered more work. Conflating them is what produced
     * the original bug, so they stay separate handlers with separate authorization.
     *
     * AUTHORIZATION. Advertising availability is a privileged claim, so it is gated on the
     * same `claimsAreVerifiedHelper` predicate matching uses to filter candidates (B11).
     * Without that, an unverified account could inject itself into the index and matching's
     * own filter would be the only thing standing between them and a stranger's front door.
     * The refusal is explicit (`NOT_AUTHORIZED` + a failed ack) rather than a silent drop,
     * because "you are not verified yet" is the single most useful thing the client can tell
     * a helper who is waiting for work that will never come.
     */
    socket.on("publish-availability", (payload, rawAck) => {
      const ack = optionalAck(rawAck);
      const p = parseOrRefuse(
        socket,
        "publish-availability",
        publishAvailabilitySchema,
        payload,
        ack,
      );
      if (!p) return;

      void (async () => {
        try {
          if (!claimsAreVerifiedHelper(claims)) {
            emitSocketError(socket, {
              event: "publish-availability",
              code: "NOT_AUTHORIZED",
              message: "verified helper role required to publish availability",
            });
            return ack({ ok: false, error: "not-a-verified-helper" });
          }

          const allowed = await consumeToken(
            client,
            keys.bucket("publish-availability", userId),
            AVAILABILITY_LIMIT,
            deps.now(),
          );
          if (!allowed) {
            emitSocketError(socket, {
              event: "publish-availability",
              code: "RATE_LIMITED",
              message: "too many availability updates",
            });
            return ack({ ok: false, error: "rate-limited" });
          }

          if (p.available) {
            // The freshness stamp is what gives the entry a TTL (B9): Redis GEO members have
            // no per-member expiry, so a helper who closes their laptop would otherwise stay
            // a candidate forever. Matching intersects the geo hits with this index, and the
            // sweep below evicts anything past AVAILABILITY_TTL_MS.
            await upsertHelperGeo(client, userId, p.point.lng, p.point.lat, deps.now());
            const presence = await patchPresence(client, userId, {
              state: "online-available",
              lastActiveAt: deps.now(),
            });
            await broadcast(presence);
          } else {
            // An explicit de-list, not a wait for the TTL. A helper who just switched off
            // must stop receiving offers now — otherwise they get a request up to a minute
            // after saying they were done, and the requester waits on someone who won't come.
            await removeHelperGeo(client, userId);
          }
          ack({ ok: true });
        } catch (err) {
          deps.logger.error("presence: publish-availability failed", { err, userId });
          emitSocketError(socket, {
            event: "publish-availability",
            code: "INTERNAL",
            message: "could not publish availability",
          });
          ack({ ok: false, error: "internal" });
        }
      })();
    });

    socket.on("set-activity", (payload) => {
      const activity = parseOrRefuse(socket, "set-activity", setActivitySchema, payload);
      if (!activity) return;
      void (async () => {
        try {
          const presence = await patchPresence(client, userId, {
            activity,
            lastActiveAt: deps.now(),
          });
          await broadcast(presence);
        } catch (err) {
          deps.logger.error("presence: set-activity failed", { err, userId });
        }
      })();
    });

    /**
     * Subscribe to a helper's presence.
     *
     * AUTHORIZATION (audit B9): this used to accept any helperId from any caller, so any
     * token holder could register for a live feed of any user's presence — a
     * "when is this person at home / active" oracle over the whole user base, which for
     * this audience is a stalking primitive rather than a privacy nit. A subscription is now
     * only granted for a helper the caller actually shares a task with.
     */
    socket.on("subscribe", (payload) => {
      const p = parseOrRefuse(socket, "subscribe", subscribeSchema, payload);
      if (!p) return;
      void (async () => {
        try {
          const allowed = await consumeToken(
            client,
            keys.bucket("presence-subscribe", userId),
            SUBSCRIBE_LIMIT,
            deps.now(),
          );
          if (!allowed) {
            emitSocketError(socket, {
              event: "subscribe",
              code: "RATE_LIMITED",
              message: "too many subscriptions",
            });
            return;
          }

          // Subscribing to yourself is always fine and needs no task.
          if (p.helperId !== userId) {
            const tasks = await deps.tasks.activeForUser(userId);
            const shares = tasks.some(
              (t) => t.helperId === p.helperId || t.requesterId === p.helperId,
            );
            if (!shares) {
              emitSocketError(socket, {
                event: "subscribe",
                code: "NOT_AUTHORIZED",
                message: "no shared task with that user",
              });
              return;
            }
          }

          await addPresenceSub(client, p.helperId, userId);
          // Hand the subscriber the helper's current presence so the UI has initial state
          // without waiting for the next change.
          const presence = await readPresence(client, p.helperId);
          if (presence) socket.emit("presence-changed", presence);
        } catch (err) {
          deps.logger.error("presence: subscribe failed", {
            err,
            userId,
            helperId: p.helperId,
          });
        }
      })();
    });

    socket.on("unsubscribe", (payload) => {
      const p = parseOrRefuse(socket, "unsubscribe", subscribeSchema, payload);
      if (!p) return;
      void (async () => {
        try {
          await removePresenceSub(client, p.helperId, userId);
        } catch (err) {
          deps.logger.error("presence: unsubscribe failed", {
            err,
            userId,
            helperId: p.helperId,
          });
        }
      })();
    });

    socket.on("disconnect", () => {
      connected.delete(userId);
      void (async () => {
        try {
          // Audit B10: only the LAST socket flips the user offline. This used to write
          // "offline" unconditionally, so a second tab closing — or even a plain reconnect,
          // where the new socket connects before the old one's disconnect lands — marked a
          // present user absent, and matching stopped considering a helper who was right
          // there. The count is in Redis because the two sockets may be on two instances.
          const remaining = await decrSocketCount(client, userId);
          if (remaining > 0) return;

          const presence = await patchPresence(client, userId, {
            state: "offline",
          });
          await broadcast(presence);
          // Genuinely gone ⇒ no longer available. Not left to the TTL: the whole point of an
          // availability index is that everything in it is someone who would actually answer.
          await removeHelperGeo(client, userId);
        } catch (err) {
          deps.logger.error("presence: disconnect failed", { err, userId });
        }
      })();
    });
  });

  // Single away-sweep for the whole namespace (never per-socket): flip anyone who has gone
  // AWAY_AFTER_MS without a beat from online-* to away. The constant already encodes two
  // missed beats, so we never flip on a single miss.
  //
  // The same tick evicts stale availability entries (audit B9). It has to be a sweep rather
  // than a TTL because Redis GEO has no per-member expiry, and it has to be here rather than
  // in matching so that an empty candidate list is never explained by a phantom that matching
  // itself declined to clean up.
  const sweep = setInterval(() => {
    void (async () => {
      const now = deps.now();
      const cutoff = now - AWAY_AFTER_MS;
      for (const userId of connected) {
        try {
          const current = await readPresence(client, userId);
          if (!current) continue;
          if (!current.state.startsWith("online-")) continue;
          if (current.lastActiveAt > cutoff) continue;
          const presence = await patchPresence(client, userId, {
            state: "away",
          });
          await broadcast(presence);
          // An away helper is not answering a request either, so they leave the index too.
          // Without this, matching's own freshness intersection is the only thing preventing
          // an offer to someone who stopped beating — and that is a second chance to get the
          // same question wrong.
          await removeHelperGeo(client, userId);
        } catch (err) {
          deps.logger.error("presence: away-sweep failed", { err, userId });
        }
      }
      try {
        const evicted = await sweepStaleHelperGeo(client, now - AVAILABILITY_TTL_MS);
        if (evicted > 0) {
          deps.logger.debug?.("presence: evicted stale availability entries", { evicted });
        }
      } catch (err) {
        deps.logger.error("presence: availability sweep failed", { err });
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the process alive purely for the sweep.
  sweep.unref?.();
};
