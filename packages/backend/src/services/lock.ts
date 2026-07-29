import type { RedisClient } from "../redis.js";

/** Redis distributed lock guarding first-accept-wins on a match (§2.4). Acquire with
 *  SET NX PX; release only if we still own the token (Lua compare-and-del) so a slow
 *  holder can't delete a lock that has since been re-acquired by someone else. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export interface Lock {
  key: string;
  token: string;
}

export async function acquireLock(
  redis: RedisClient,
  key: string,
  token: string,
  ttlMs = 5_000,
): Promise<Lock | null> {
  const res = await redis.set(key, token, "PX", ttlMs, "NX");
  return res === "OK" ? { key, token } : null;
}

export async function releaseLock(redis: RedisClient, lock: Lock): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
}

/** Run `fn` while holding the lock; returns null without running if the lock is held
 *  elsewhere. Always releases, even if `fn` throws. */
export async function withLock<T>(
  redis: RedisClient,
  key: string,
  token: string,
  fn: () => Promise<T>,
  ttlMs = 5_000,
): Promise<T | null> {
  const lock = await acquireLock(redis, key, token, ttlMs);
  if (!lock) return null;
  try {
    return await fn();
  } finally {
    await releaseLock(redis, lock);
  }
}
