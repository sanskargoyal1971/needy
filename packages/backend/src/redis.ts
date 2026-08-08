import { Redis } from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

/** Three connections: a general command client, plus a dedicated pub/sub pair for the
 *  socket.io adapter (a subscribed connection can't issue normal commands). */

export type RedisRole = "client" | "pub" | "sub";

/** Per-connection liveness, derived from ioredis' own status plus the error stream. */
export interface RedisConnectionHealth {
  role: RedisRole;
  /** ioredis status: "wait" | "connecting" | "connect" | "ready" | "close" | "end". */
  status: string;
  ready: boolean;
  /** Cumulative error count since boot — a climbing number alongside `ready:true` means the
   *  connection is flapping rather than cleanly down, which reads very differently on-call. */
  errorCount: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface RedisHealthSnapshot {
  /** Every connection is handshaked and usable. */
  ready: boolean;
  /** At least one connection is not ready. Deliberately the inverse of `ready` rather than a
   *  sticky flag: once Redis comes back, /health has to recover on its own without a restart. */
  degraded: boolean;
  connections: RedisConnectionHealth[];
}

export interface RedisHealth {
  snapshot(): RedisHealthSnapshot;
}

/** The command client type used everywhere in the app. */
export type RedisClient = Redis;

export interface RedisClients {
  client: RedisClient;
  pub: RedisClient;
  sub: RedisClient;
  /** Connection health for GET /health. Optional so the many test doubles that hand a
   *  `{client, pub, sub}` triple (ioredis-mock) stay valid — a missing `health` means
   *  "unknown, probe instead", never "unhealthy". */
  health?: RedisHealth;
}

/** Render an ioredis connection error usefully. The common dual-stack refusal arrives as an
 *  `AggregateError` whose own `message` is the EMPTY STRING (the detail lives in `.errors`), so
 *  naive `String(err.message)` logging produced a line that said nothing at all — the single
 *  most important log line during a Redis outage. `code` (ECONNREFUSED/ETIMEDOUT) is what an
 *  operator actually needs, so it leads. */
function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; errors?: unknown[] } | null;
  if (!e) return "unknown error";
  const parts: string[] = [];
  if (e.code) parts.push(e.code);
  if (e.message) parts.push(e.message);
  if (parts.length === 0 && Array.isArray(e.errors)) {
    const inner = e.errors
      .map((x) => (x as { message?: string } | null)?.message)
      .filter((m): m is string => typeof m === "string" && m.length > 0);
    if (inner.length > 0) parts.push(inner.join("; "));
  }
  if (parts.length === 0) parts.push(e.name ?? String(err));
  return parts.join(": ").slice(0, 300);
}

/** Error logs are throttled per connection: ioredis retries with backoff (~50ms → 2s), so an
 *  unreachable Redis would otherwise emit tens of identical lines a minute, forever. The first
 *  error of each outage stays loud and the rest are summarised, so an incident is visible in
 *  the log without drowning it. */
const ERROR_LOG_INTERVAL_MS = 10_000;

/**
 * Audit B8 — all three clients were created with ZERO `.on("error")` handlers. ioredis emits
 * `error` on connection loss, and an EventEmitter `error` with no listener is an UNCAUGHT
 * EXCEPTION: one Redis blip (or a `docker compose down`) took the entire API process with it.
 * Attaching a listener is also what lets ioredis do the thing it is designed to do — queue
 * commands and reconnect with backoff — instead of crashing the box.
 *
 * The bookkeeping here doubles as the source of truth for GET /health, so a degraded Redis is
 * *reported* rather than silently swallowed.
 */
function track(role: RedisRole, connection: Redis): RedisConnectionHealth {
  const state: RedisConnectionHealth = {
    role,
    status: connection.status,
    ready: false,
    errorCount: 0,
    lastError: null,
    lastErrorAt: null,
  };

  let lastLoggedAt = 0;
  let suppressedSinceLastLog = 0;

  connection.on("error", (err: Error) => {
    state.errorCount += 1;
    state.lastError = describeError(err);
    state.lastErrorAt = Date.now();
    state.ready = false;

    // Wall-clock is read directly here rather than through deps.now(): this is transport-level
    // infrastructure logging that exists below the injected-clock layer, and it must keep
    // working when nothing else is wired up yet (createRedisClients runs first at boot).
    const at = state.lastErrorAt;
    if (at - lastLoggedAt >= ERROR_LOG_INTERVAL_MS) {
      logger.error("redis connection error", {
        role,
        err: state.lastError,
        errorCount: state.errorCount,
        suppressedSinceLastLog,
      });
      lastLoggedAt = at;
      suppressedSinceLastLog = 0;
    } else {
      suppressedSinceLastLog += 1;
    }
  });

  connection.on("ready", () => {
    state.ready = true;
    state.status = connection.status;
    logger.info("redis ready", { role });
  });
  connection.on("close", () => {
    state.ready = false;
    state.status = connection.status;
    logger.warn("redis connection closed — reconnecting", { role });
  });
  connection.on("end", () => {
    state.ready = false;
    state.status = connection.status;
    logger.warn("redis connection ended (no further reconnects)", { role });
  });
  connection.on("reconnecting", (delayMs: number) => {
    state.status = connection.status;
    logger.warn("redis reconnecting", { role, delayMs });
  });

  return state;
}

export function createRedisClients(): RedisClients {
  const client = new Redis(config.redisUrl, { lazyConnect: false });
  const pub = client.duplicate();
  const sub = client.duplicate();

  const tracked: Array<{ state: RedisConnectionHealth; connection: Redis }> = (
    [
      ["client", client],
      ["pub", pub],
      ["sub", sub],
    ] as Array<[RedisRole, Redis]>
  ).map(([role, connection]) => ({ state: track(role, connection), connection }));

  const health: RedisHealth = {
    snapshot(): RedisHealthSnapshot {
      const connections = tracked.map(({ state, connection }) => ({
        ...state,
        // `status` is re-read live: it's ioredis' authoritative view and it moves through
        // states without always emitting an event we subscribe to.
        status: connection.status,
        ready: connection.status === "ready",
      }));
      const ready = connections.every((c) => c.ready);
      return { ready, degraded: !ready, connections };
    },
  };

  // `health` is purely additive — every existing caller destructures {client, pub, sub}.
  return { client, pub, sub, health };
}
