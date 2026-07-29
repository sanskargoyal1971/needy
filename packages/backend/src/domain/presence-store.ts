import {
  type ActivityContext,
  type Presence,
  type PresenceState,
} from "@needy/shared";
import type { RedisClient } from "../redis.js";
import { keys } from "./keys.js";

/** Read/write accessors for the presence Redis hash. Shared by the /presence namespace
 *  (which owns the socket wiring + away-sweep) and by matching (which filters candidates
 *  to `online-available`). Centralizing the hash shape keeps the two in lockstep. */

export async function writePresence(
  redis: RedisClient,
  presence: Presence,
): Promise<void> {
  await redis.hmset(keys.presence(presence.userId), {
    state: presence.state,
    activity: presence.activity,
    lastActiveAt: String(presence.lastActiveAt),
  });
}

export async function readPresence(
  redis: RedisClient,
  userId: string,
): Promise<Presence | null> {
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

export async function listPresenceSubs(
  redis: RedisClient,
  helperId: string,
): Promise<string[]> {
  return redis.smembers(keys.presenceSubs(helperId));
}
