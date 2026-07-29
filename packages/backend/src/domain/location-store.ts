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

/** Upsert a helper's live position into the GEO set matching queries with GEOSEARCH. */
export async function upsertHelperGeo(
  redis: RedisClient,
  helperId: string,
  lng: number,
  lat: number,
): Promise<void> {
  await redis.geoadd(keys.helperGeo(), lng, lat, helperId);
}

export async function removeHelperGeo(
  redis: RedisClient,
  helperId: string,
): Promise<void> {
  await redis.zrem(keys.helperGeo(), helperId);
}
