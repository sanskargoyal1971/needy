import type { LocationUpdate } from "@needy/shared";
import type { RedisClient } from "../redis.js";
import { keys } from "./keys.js";

/** Only the CURRENT helper position per task is stored, TTL'd to task duration (§2.3) —
 *  we deliberately do NOT persist a location trail. Written by /tracking on each update,
 *  read by the reconnect snapshot so a returning client can place the marker immediately.
 *  Also maintains the GEO set matching searches against. */

const LOCATION_TTL_SECONDS = 60 * 60 * 4; // generous upper bound on a single task

export async function setTaskLocation(
  redis: RedisClient,
  taskId: string,
  update: LocationUpdate,
): Promise<void> {
  await redis.set(
    keys.taskLocation(taskId),
    JSON.stringify(update),
    "EX",
    LOCATION_TTL_SECONDS,
  );
}

export async function getTaskLocation(
  redis: RedisClient,
  taskId: string,
): Promise<LocationUpdate | null> {
  const raw = await redis.get(keys.taskLocation(taskId));
  return raw ? (JSON.parse(raw) as LocationUpdate) : null;
}

export async function clearTaskLocation(
  redis: RedisClient,
  taskId: string,
): Promise<void> {
  await redis.del(keys.taskLocation(taskId));
}

/** Upsert a helper's live position into the GEO set matching queries with GEOSEARCH.
 *
 *  `at` stamps a companion freshness index (audit A1/B9). Redis GEO members have no
 *  individual TTL, so without this an entry written once stayed forever and matching would
 *  keep offering work to a helper who closed their laptop days ago. Callers pass
 *  `deps.now()` so the decay is testable against the injected clock. */
export async function upsertHelperGeo(
  redis: RedisClient,
  helperId: string,
  lng: number,
  lat: number,
  at: number,
): Promise<void> {
  await redis
    .multi()
    .geoadd(keys.helperGeo(), lng, lat, helperId)
    .zadd(keys.helperGeoFresh(), at, helperId)
    .exec();
}

/** Drop a helper from the availability index entirely — they went offline, went busy, or
 *  aged out. Removes from both the GEO set and the freshness index. */
export async function removeHelperGeo(
  redis: RedisClient,
  helperId: string,
): Promise<void> {
  await redis
    .multi()
    .zrem(keys.helperGeo(), helperId)
    .zrem(keys.helperGeoFresh(), helperId)
    .exec();
}

/** helperIds whose availability publish is newer than `cutoff`. Matching intersects its
 *  GEOSEARCH hits with this so a stale position can never produce an offer. */
export async function freshHelperIds(
  redis: RedisClient,
  cutoff: number,
): Promise<Set<string>> {
  const ids = await redis.zrangebyscore(keys.helperGeoFresh(), cutoff, "+inf");
  return new Set(ids);
}

/** Evict everything that stopped publishing before `cutoff`. Run periodically so the GEO
 *  set stays bounded even for helpers who never cleanly disconnected. Returns the count
 *  removed, for logging. */
export async function sweepStaleHelperGeo(
  redis: RedisClient,
  cutoff: number,
): Promise<number> {
  const stale = await redis.zrangebyscore(keys.helperGeoFresh(), "-inf", cutoff);
  if (stale.length === 0) return 0;
  await redis
    .multi()
    .zrem(keys.helperGeo(), ...stale)
    .zrem(keys.helperGeoFresh(), ...stale)
    .exec();
  return stale.length;
}
