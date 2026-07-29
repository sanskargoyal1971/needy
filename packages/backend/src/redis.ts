import { Redis } from "ioredis";
import { config } from "./config.js";

/** Three connections: a general command client, plus a dedicated pub/sub pair for the
 *  socket.io adapter (a subscribed connection can't issue normal commands). */
export function createRedisClients() {
  const client = new Redis(config.redisUrl, { lazyConnect: false });
  const pub = client.duplicate();
  const sub = client.duplicate();
  return { client, pub, sub };
}

export type RedisClients = ReturnType<typeof createRedisClients>;
export type RedisClient = RedisClients["client"];
