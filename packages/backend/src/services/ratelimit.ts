import type { RedisClient } from "../redis.js";

/** Token-bucket rate limiter in Redis (§2.5) to blunt chat spam/harassment. Refills
 *  `ratePerSec` tokens/second up to `capacity`; each send costs one token. State is a
 *  hash {tokens, ts}; the whole check-and-consume runs atomically in Lua so concurrent
 *  sends from one user can't both pass a near-empty bucket. */
const CONSUME_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call("hmget", key, "tokens", "ts")
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end

local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * rate)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call("hmset", key, "tokens", tokens, "ts", now)
redis.call("pexpire", key, math.ceil(capacity / rate * 1000) + 1000)
return allowed`;

export interface RateLimit {
  capacity: number;
  ratePerSec: number;
}

/** Returns true if the action is permitted (a token was consumed). `nowMs` is injected
 *  so tests are deterministic. */
export async function consumeToken(
  redis: RedisClient,
  key: string,
  limit: RateLimit,
  nowMs: number,
  cost = 1,
): Promise<boolean> {
  const allowed = await redis.eval(
    CONSUME_SCRIPT,
    1,
    key,
    limit.capacity,
    limit.ratePerSec,
    nowMs,
    cost,
  );
  return allowed === 1;
}

/** Default chat budget: burst of 8 messages, sustained ~1/sec. */
export const CHAT_LIMIT: RateLimit = { capacity: 8, ratePerSec: 1 };
