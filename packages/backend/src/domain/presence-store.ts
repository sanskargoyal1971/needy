import { type ActivityContext, type Presence, type PresenceState } from "@needy/shared";
import type { RedisClient } from "../redis.js";
import { keys } from "./keys.js";

/** Read/write accessors for the presence Redis hash. Shared by the /presence namespace
 *  (which owns the socket wiring + away-sweep) and by matching (which filters candidates
 *  to `online-available`). Centralizing the hash shape keeps the two in lockstep. */

export async function writePresence(redis: RedisClient, presence: Presence): Promise<void> {
  await redis.hmset(keys.presence(presence.userId), {
    state: presence.state,
    activity: presence.activity,
    lastActiveAt: String(presence.lastActiveAt),
  });
}

export async function readPresence(redis: RedisClient, userId: string): Promise<Presence | null> {
  const h = await redis.hgetall(keys.presence(userId));
  if (!h || !h.state) return null;
  return {
    userId,
    state: h.state as PresenceState,
    activity: (h.activity as ActivityContext) ?? "idle",
    lastActiveAt: Number(h.lastActiveAt ?? 0),
  };
}

export async function patchPresence(
  redis: RedisClient,
  userId: string,
  patch: Partial<Pick<Presence, "state" | "activity" | "lastActiveAt">>,
): Promise<Presence> {
  const current =
    (await readPresence(redis, userId)) ??
    ({
      userId,
      state: "offline",
      activity: "idle",
      lastActiveAt: 0,
    } satisfies Presence);
  const next: Presence = { ...current, ...patch, userId };
  await writePresence(redis, next);
  return next;
}

/** Requester→helper presence subscription set (§2.2): who should receive a helper's
 *  presence-changed events. Kept small and scoped, never a global broadcast. */
export async function addPresenceSub(
  redis: RedisClient,
  helperId: string,
  requesterId: string,
): Promise<void> {
  await redis.sadd(keys.presenceSubs(helperId), requesterId);
}

export async function removePresenceSub(
  redis: RedisClient,
  helperId: string,
  requesterId: string,
): Promise<void> {
  await redis.srem(keys.presenceSubs(helperId), requesterId);
}

export async function listPresenceSubs(redis: RedisClient, helperId: string): Promise<string[]> {
  return redis.smembers(keys.presenceSubs(helperId));
}

/** ── Per-user socket refcount (audit B10) ──────────────────────────────────
 *
 *  The bug: `disconnect` unconditionally wrote `state: "offline"`. A user with the app open
 *  on a phone and a tablet — or simply one who had just reconnected, since socket.io's new
 *  socket connects BEFORE the old one's disconnect always lands — was marked offline while
 *  still very much present. For a helper that means matching stops considering them; for a
 *  requester it means their helper sees them go dark mid-task.
 *
 *  A per-process counter would not fix it: with the Redis adapter the two tabs may be on
 *  different instances, so the count has to live where both can see it. INCR/DECR return the
 *  new value atomically, which is exactly the "am I the last one out?" test we need.
 *
 *  The key is TTL'd on every increment. Without that, a process killed between INCR and DECR
 *  leaves a permanently positive count and the user can never go offline again — a leak that
 *  only ever accumulates. The TTL is refreshed by each new connection, so it can only expire
 *  once genuinely nobody has connected for that long.
 */
const SOCKET_COUNT_TTL_SECONDS = 60 * 60 * 12;

/** Register a new live socket. Returns the resulting count (≥1). */
export async function incrSocketCount(redis: RedisClient, userId: string): Promise<number> {
  const key = keys.socketCount(userId);
  const [[, count]] = (await redis
    .multi()
    .incr(key)
    .expire(key, SOCKET_COUNT_TTL_SECONDS)
    .exec()) as [[Error | null, number], ...unknown[]];
  return count;
}

/** Release a socket. Returns the remaining count; 0 means this was the last one and the
 *  caller should flip the user offline. Clamped at 0 and self-healing: a stray decrement
 *  (a double-disconnect, a count lost to a restart) deletes the key rather than leaving a
 *  negative value that would make every future disconnect look like "others still here". */
export async function decrSocketCount(redis: RedisClient, userId: string): Promise<number> {
  const key = keys.socketCount(userId);
  const remaining = await redis.decr(key);
  if (remaining <= 0) {
    await redis.del(key);
    return 0;
  }
  return remaining;
}
