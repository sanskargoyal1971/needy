import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  NS,
  type LatLng,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type MatchOffer,
  type Task,
  type TaskCategory,
} from "@needy/shared";
import { config, type Config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import type { Role, User } from "../../auth/types.js";
import type { Deps } from "../../domain/deps.js";
import { keys } from "../../domain/keys.js";
import { upsertHelperGeo } from "../../domain/location-store.js";
import { writePresence } from "../../domain/presence-store.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import type { Logger } from "../../logger.js";
import { authMiddleware } from "../auth.js";
import { registerMatching } from "../matching.js";

/**
 * The offer-expiry CLAIM, driven through the real `closeExpiredOffer` path (audit C19).
 *
 * WHY THIS IS A SEPARATE FILE FROM matching.authz.test.ts.
 * That suite freezes `deps.now()` so it can assert exact expiry scores, and moves the clock in
 * jumps. Under a frozen clock the best-effort in-process timer never matters: it is armed for
 * `offerWindowMs` of REAL time, so at a 60 s window it cannot fire inside a test. But that
 * timer is precisely the caller that can arrive with a STALE taskId — it fires blind, one full
 * window after it was armed, by which time the entry under that taskId may belong to a
 * completely different, still-live offer.
 *
 * So this suite does the opposite: a REAL clock and a deliberately tiny offer window, so the
 * genuine timer fires within the test. Nothing here reimplements the claim; every assertion
 * comes from `registerMatching`'s own behaviour, which is what makes it evidence about the
 * server rather than about a copy of its Lua.
 *
 * REAL REDIS on db 15 under a per-run prefix, deleted in `afterAll` — never `flushdb`.
 */

type AppClient = ClientSocket<MatchingServerEvents, MatchingClientEvents>;
type OkAck = { ok: true } | { ok: false; error: string };

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const REDIS_DB = 15;
const KEY_PREFIX = `test:matching-expiry:${process.pid}:${Date.now()}:`;

const ORIGIN: LatLng = { lat: 12.9716, lng: 77.5946 };

/**
 * Short enough that the in-process timer fires inside a test, long enough that the ~10 ms of
 * socket round-trips around a `request-help` cannot consume the whole window. The durable
 * sweep runs every 1 s regardless, so anything the timer misses is collected shortly after —
 * which is why the assertions below distinguish the two by ORDER of events, not by wall time.
 */
const OFFER_WINDOW_MS = 400;

const REQUESTER = "expiry-req";
const HELPER = "expiry-helper";

/** Offer #1 lapses here, arming a timer that will fire ~400 ms later. */
const T_FIRST = "task-expiry-first";
/** Re-requested immediately after #1's closure, so the stale timer lands on a LIVE entry. */
const T_SECOND = "task-expiry-second";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ]);
}

function connect(port: number, userId: string, role: Role): Promise<AppClient> {
  const token = signAccessToken({ sub: userId, role, displayName: userId });
  const socket: AppClient = ioClient(`http://localhost:${port}${NS.matching}`, {
    transports: ["websocket"],
    auth: { token },
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

const requestHelp = (socket: AppClient, taskId: string): Promise<OkAck> =>
  new Promise((resolve) => socket.emit("request-help", { taskId }, resolve));

describe("/matching offer-expiry claim under a real clock (C19)", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let client: RedisClient;
  let janitor: Redis;
  let requester: AppClient;
  let helper: AppClient;

  const tasks = createInMemoryTaskRepo();
  const users = createInMemoryUserRepo();

  const offers: MatchOffer[] = [];
  const closures: { taskId: string; reason: string }[] = [];

  const now = (): number => Date.now();

  const seedTask = (id: string): Promise<Task> =>
    tasks.create({
      id,
      requesterId: REQUESTER,
      helperId: null,
      category: "errand" as TaskCategory,
      state: "searching",
      origin: ORIGIN,
      title: "Pick up medicine",
      description: "test", price: 100, createdAt: now(),
      updatedAt: now(),
    });

  const seedUser = (id: string, role: Role, kycStatus: User["kycStatus"]) =>
    users.create({
      id,
      phone: `+9199991${id.length}${id.slice(-2)}`,
      email: null,
      displayName: id,
      role,
      kycStatus,
      createdAt: 0,
      updatedAt: 0,
    });

  /** Re-list the helper: `accept` de-lists a winner, and availability freshness is scored
   *  against the real clock here, so each new search needs a current publish. */
  const publishHelper = (): Promise<void> =>
    upsertHelperGeo(client, HELPER, 77.595, 12.972, now());

  /** C20 bounds `request-help` at capacity 10 / 0.5 per second. This suite issues several in
   *  quick succession, so hand the bucket back rather than sleeping out the refill. */
  const resetRequestHelpLimit = (): Promise<number> =>
    client.del(keys.bucket("request-help", REQUESTER));

  beforeAll(async () => {
    client = new Redis(REDIS_URL, {
      db: REDIS_DB,
      keyPrefix: KEY_PREFIX,
    }) as unknown as RedisClient;
    janitor = new Redis(REDIS_URL, { db: REDIS_DB });
    await client.ping();
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    await seedUser(REQUESTER, "requester", "verified");
    await seedUser(HELPER, "helper", "verified");
    await publishHelper();
    for (const userId of [REQUESTER, HELPER]) {
      await writePresence(client, {
        userId,
        state: "online-available",
        activity: "idle",
        lastActiveAt: now(),
      });
    }
    await seedTask(T_FIRST);
    await seedTask(T_SECOND);

    httpServer = createServer();
    io = new IOServer(httpServer);
    const deps: Deps = {
      io,
      redis,
      logger: silentLogger,
      config: {
        ...config,
        match: { ...config.match, offerWindowMs: OFFER_WINDOW_MS },
      } as Config,
      tasks,
      messages: createInMemoryMessageRepo(),
      helpers: createInMemoryHelperProfileRepo({}),
      sos: createInMemorySosRepo(),
      users,
      // REAL clock — the whole point of this file.
      now,
    };
    io.of(NS.matching).use(authMiddleware);
    registerMatching(deps);

    await new Promise<void>((r) => httpServer.listen(0, r));
    const port = (httpServer.address() as AddressInfo).port;
    requester = await connect(port, REQUESTER, "requester");
    helper = await connect(port, HELPER, "helper");
    helper.on("offer", (o) => offers.push(o));
    helper.on("offer-closed", (c) => closures.push(c));
  });

  afterAll(async () => {
    for (const c of [requester, helper]) c?.disconnect();
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    const ours = await janitor.keys(`${KEY_PREFIX}*`);
    if (ours.length > 0) await janitor.del(...ours);
    await client.quit();
    await janitor.quit();
  });

  it("does not let offer #1's stale timer close the LIVE offer #2 for a different task", async () => {
    // ── offer #1: opened, then allowed to lapse. ────────────────────────────
    // Its in-process timer is now armed and will fire ~OFFER_WINDOW_MS from here, whatever
    // else has happened by then.
    await resetRequestHelpLimit();
    await publishHelper();
    expect(await requestHelp(requester, T_FIRST)).toEqual({ ok: true });
    await withTimeout(
      new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          if (closures.some((c) => c.taskId === T_FIRST)) {
            clearInterval(tick);
            resolve();
          }
        }, 10);
      }),
      5_000,
      "offer #1 to lapse",
    );
    expect(await client.zscore(keys.offerExpiryQueue(), T_FIRST)).toBeNull();

    // ── offer #2, opened immediately afterwards ─────────────────────────────
    // A DIFFERENT task, so the two entries never collide by key. This is the honest version of
    // the hazard: `closeExpiredOffer(taskId)` is only ever wrong about the task it names, so
    // the stale timer's real victim is a re-request of the SAME task — covered below. This case
    // establishes the baseline: unrelated live offers are untouched while timers fire around
    // them.
    await resetRequestHelpLimit();
    await publishHelper();
    expect(await requestHelp(requester, T_SECOND)).toEqual({ ok: true });
    expect(offers.map((o) => o.taskId)).toContain(T_SECOND);

    // Let offer #1's timer fire (and a sweep pass or two run) while #2 is still live.
    await settle(OFFER_WINDOW_MS / 2);
    expect(closures.filter((c) => c.taskId === T_FIRST)).toHaveLength(1);
    expect(closures.some((c) => c.taskId === T_SECOND)).toBe(false);
    expect(await client.sismember(keys.offerAudience(T_SECOND), HELPER)).toBe(1);
  });

  it("does not let a stale timer close a RE-REQUEST of the same task before its window", async () => {
    // The one that matters, and the one a bare ZREM gets wrong.
    //
    // Sequence: request T (timer A armed) → T's offer lapses and is closed → the requester
    // searches again for the SAME T, so a NEW entry exists with a NEW window → some LATER
    // timer/sweep call for T arrives while that second window is still open. Under a bare
    // `zrem` the claim returns 1 and the still-live second offer is closed early: the helper's
    // card is torn down and the audience set — which `accept` authorizes against — is deleted,
    // so every helper who was legitimately offered T is then refused. The `score <= now` guard
    // is what makes the stale call a no-op.
    const T = "task-expiry-rerequest";
    await seedTask(T);

    await resetRequestHelpLimit();
    await publishHelper();
    expect(await requestHelp(requester, T)).toEqual({ ok: true });
    await withTimeout(
      new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          if (closures.some((c) => c.taskId === T)) {
            clearInterval(tick);
            resolve();
          }
        }, 10);
      }),
      5_000,
      "the first offer for T to lapse",
    );
    const firstClosures = closures.filter((c) => c.taskId === T).length;
    expect(firstClosures).toBe(1);

    // Second search for the same task. Note this must be a NEW window, not an extension: the
    // handler's ZADD NX sees no entry (the closure removed it) and writes a fresh score.
    await resetRequestHelpLimit();
    await publishHelper();
    expect(await requestHelp(requester, T)).toEqual({ ok: true });
    const secondWindow = Number(await client.zscore(keys.offerExpiryQueue(), T));
    expect(secondWindow).toBeGreaterThan(now());
    expect(await client.sismember(keys.offerAudience(T), HELPER)).toBe(1);

    // Now the stale caller. A duplicate `request-help` inside the live window is the shipped
    // path that arms a SECOND blind timer for T — the first of which is already in flight from
    // the lapsed offer. Both will call closeExpiredOffer(T); neither knows which window it
    // belongs to.
    expect(await requestHelp(requester, T)).toEqual({ ok: true });

    // Half a window later: the stale timer has fired. The live offer must be intact.
    await settle(OFFER_WINDOW_MS / 2);
    expect(closures.filter((c) => c.taskId === T)).toHaveLength(firstClosures);
    expect(Number(await client.zscore(keys.offerExpiryQueue(), T))).toBe(secondWindow);
    expect(await client.sismember(keys.offerAudience(T), HELPER)).toBe(1);

    // And once the second window genuinely lapses it closes exactly once — so the guard
    // suppresses the stale call without breaking the real one.
    await withTimeout(
      new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          if (closures.filter((c) => c.taskId === T).length > firstClosures) {
            clearInterval(tick);
            resolve();
          }
        }, 10);
      }),
      5_000,
      "the second offer for T to lapse",
    );
    // Several sweep passes plus the duplicate's timer, all after the window: still one closure
    // for this offer, which is the at-most-once property itself.
    await settle(1_500);
    expect(closures.filter((c) => c.taskId === T)).toHaveLength(firstClosures + 1);
    expect(await client.zscore(keys.offerExpiryQueue(), T)).toBeNull();
  });
});
