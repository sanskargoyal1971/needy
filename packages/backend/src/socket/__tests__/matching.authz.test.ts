import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  AVAILABILITY_TTL_MS,
  NS,
  type LatLng,
  type MatchedHelper,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type MatchOffer,
  type Task,
  type TaskCategory,
  type TaskState,
} from "@needy/shared";
import { config, type Config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { makeUser, type Role, type User } from "../../auth/types.js";
import type { Deps } from "../../domain/deps.js";
import { keys } from "../../domain/keys.js";
import { setTaskLocation, upsertHelperGeo } from "../../domain/location-store.js";
import { writePresence } from "../../domain/presence-store.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import { acquireLock, releaseLock } from "../../services/lock.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import type { Logger } from "../../logger.js";
import { authMiddleware } from "../auth.js";
import { claimLapsedOffer, registerMatching } from "../matching.js";

/**
 * Authorization + eligibility proofs for /matching (audit A6, B11, B12 and the two missing
 * `accept` checks). Sibling of matching.race.test.ts, same harness shape: a real socket.io
 * server driving the real `registerMatching`, so every rule is exercised over the wire
 * rather than by calling internals.
 *
 * REAL REDIS, not ioredis-mock. This suite needs the GEO family (`geoadd`/`geosearch`/
 * `geopos` — matching's candidate search and the A6 ETA fallback) which ioredis-mock does
 * not implement at all, plus sorted-set scores for the durable offer-expiry schedule. Rather
 * than grow the mock's GEO shim into a second, subtly-different Redis, everything runs
 * against the live instance on db 15 under a unique per-run key prefix and is deleted in
 * `afterAll`. The prefix is what makes it safe to run concurrently with anything else.
 */

type AppClient = ClientSocket<MatchingServerEvents, MatchingClientEvents>;
type AcceptAck =
  | { won: true; task: Task }
  | { won: false; reason: "already-taken" | "expired" };
type OkAck = { ok: true } | { ok: false; error: string };
type AdvanceAck = { ok: true; task: Task } | { ok: false; error: string };

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const REDIS_DB = 15;
const KEY_PREFIX = `test:matching-authz:${process.pid}:${Date.now()}:`;

const ORIGIN: LatLng = { lat: 12.9716, lng: 77.5946 };
const FIXED_NOW = 1_700_000_000_000;
const OFFER_WINDOW_MS = 60_000;

const REQUESTER = "authz-req";
const HELPER_OK = "authz-helper-ok";
const HELPER_UNVERIFIED = "authz-helper-unverified";
/** Verified, but parked ~55 km away, so they are never in the offer audience. */
const HELPER_FAR = "authz-helper-far";
/** Joins the availability index only in the ETA-fallback case, so the audience assertions in
 *  the eligibility cases above can stay exact. */
const HELPER_ETA = "authz-helper-eta";

/** One task per scenario so the suite has no ordering coupling between cases. */
const T_ELIGIBILITY = "task-authz-eligibility";
const T_ETA = "task-authz-eta";
const T_ETA_FALLBACK = "task-authz-eta-fallback";
const T_NOT_OFFERED = "task-authz-not-offered";
const T_EXPIRED = "task-authz-expired";
const T_ROLES = "task-authz-roles";
const T_CANCEL_BY_REQUESTER = "task-authz-cancel-req";
const T_CANCEL_BY_HELPER = "task-authz-cancel-helper";
const T_DUPLICATE = "task-authz-duplicate";
const T_SWEEP = "task-authz-sweep";
/** Owned by the ack-less-frame cases below — see the note there on why they need their own. */
const T_NO_ACK = "task-authz-no-ack";
const T_NO_ACK_ADVANCE = "task-authz-no-ack-advance";
/** Cancelled while its offer was still live. */
const T_CANCEL_WHILE_SEARCHING = "task-authz-cancel-searching";
/** Two closers race this one entry while its audience is still populated. */
const T_RACE_CLAIM = "task-authz-race-claim";
/** A blind in-process timer fires against this task's still-live offer. */
const T_STALE_TIMER = "task-authz-stale-timer";
/** The freshness-intersection pair: same helper, stale then fresh. */
const T_STALE_HELPER = "task-authz-stale-helper";
const T_FRESH_HELPER = "task-authz-fresh-helper";
/** Advanced while its match lock is held by "another instance". */
const T_LOCKED = "task-authz-locked";
/** The pair that proves a winner stops being a candidate: won, then a second search. */
const T_DELIST_WON = "task-authz-delist-won";
const T_DELIST_SECOND = "task-authz-delist-second";

/** Verified + nearby + `online-available`, but their availability publish is OUTSIDE
 *  AVAILABILITY_TTL_MS — the phantom the freshness index exists to exclude. */
const HELPER_STALE = "authz-helper-stale";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The injected clock. Mutable so the expiry case can move time past the offer window
 *  without sleeping — every read in matching.ts goes through deps.now(). */
let clock = FIXED_NOW;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ]);
}

const settle = (ms = 120): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

const accept = (socket: AppClient, taskId: string): Promise<AcceptAck> =>
  new Promise((resolve) => socket.emit("accept", { taskId }, resolve));

const advance = (
  socket: AppClient,
  taskId: string,
  to: TaskState,
): Promise<AdvanceAck> =>
  new Promise((resolve) => socket.emit("advance-task", { taskId, to }, resolve));

/** Emit a frame with NO acknowledgement callback, bypassing the typed client — which would
 *  insist on one. The whole point is to send what a well-behaved client cannot produce. */
const emitRaw = (socket: AppClient, event: string, payload: unknown): void => {
  (socket as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
};

describe("/matching authorization + eligibility (audit A6 / B11 / B12)", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let client: RedisClient;
  /** Unprefixed connection, used only to enumerate and delete our prefixed keys. */
  let janitor: Redis;

  let requester: AppClient;
  let helperOk: AppClient;
  let helperUnverified: AppClient;
  let helperFar: AppClient;
  let helperEta: AppClient;

  const tasks = createInMemoryTaskRepo();
  const users = createInMemoryUserRepo();

  /** Offers each client received, keyed by the receiving userId — the B11 evidence. */
  const offers: Record<string, MatchOffer[]> = {
    [HELPER_OK]: [],
    [HELPER_UNVERIFIED]: [],
    [HELPER_FAR]: [],
    [HELPER_ETA]: [],
    [REQUESTER]: [],
  };
  const nearby: { taskId: string; count: number }[] = [];
  const matchedReveals: { task: Task; helper: MatchedHelper }[] = [];
  /** `offer-closed` deliveries to HELPER_OK. Recorded from `beforeAll` rather than inside the
   *  expiry case, because the durable sweep fires on its own interval as soon as ANY case
   *  moves the clock past a window — subscribing late would make the assertion order-dependent
   *  on which test happened to advance time first. */
  const offerClosed: { taskId: string; reason: string }[] = [];
  /** `task-updated` deliveries to the requester — the fan-out that follows a successful
   *  advance, and the thing an ack-less frame used to skip. */
  const taskUpdates: { task: Task }[] = [];
  /** Unhandled rejections. The `ack is not a function` throw happens inside an async socket.io
   *  handler, which swallows it — without watching here the failure is invisible to the test. */
  const rejections: unknown[] = [];

  const seedTask = (id: string, over: Partial<Task> = {}): Promise<Task> =>
    tasks.create({
      id,
      requesterId: REQUESTER,
      helperId: null,
      category: "errand" as TaskCategory,
      state: "searching",
      origin: ORIGIN,
      title: "Pick up medicine",
      description: "test", price: 100, createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      ...over,
    });

  /**
   * Put HELPER_OK back in the availability index.
   *
   * `accept` DE-LISTS the winner (they are busy, and a matched-but-not-yet-moving helper who
   * stayed listed could be offered a second task and strand one of the two requesters). This
   * suite reuses one helper identity across cases, so every case after the first win has to
   * re-list them — which is not a workaround but a faithful model of the live client: its
   * republish timer re-publishes availability every AVAILABILITY_TTL_MS/3 whenever the helper
   * holds no task. A case that forgets this gets "no candidates", which is the correct answer
   * for a helper who never said they were free again.
   */
  const republishHelperOk = (): Promise<void> =>
    upsertHelperGeo(client, HELPER_OK, 77.595, 12.972, clock);

  /**
   * Hand the requester's `request-help` bucket back.
   *
   * C20 bounds searches at capacity 10, refilling at 0.5/s — and this suite's clock is FROZEN,
   * so the bucket never refills on its own and case ~11 onwards would get `rate-limited`. That
   * is the limiter working correctly; advancing the clock instead would be worse, because
   * several cases here assert on exact expiry scores derived from FIXED_NOW. Dropping the
   * bucket key is the narrowest way to say "this is a fresh human, not a looping client".
   *
   * Deliberately NOT called from a global beforeEach: the rate limit has its own coverage in
   * the ratelimit suite, and a blanket reset would silently disarm it here if a future case
   * ever wanted to assert on it.
   */
  const resetRequestHelpLimit = (): Promise<number> =>
    client.del(keys.bucket("request-help", REQUESTER));

  /** Is this helper a live candidate? Both halves must be present, because matching intersects
   *  the GEO set with the freshness index — either one alone is not availability. */
  const inGeoIndex = async (userId: string): Promise<boolean> => {
    const geo = await client.zscore(keys.helperGeo(), userId);
    const fresh = await client.zscore(keys.helperGeoFresh(), userId);
    return geo != null && fresh != null;
  };

  const seedUser = (id: string, role: Role, kycStatus: User["kycStatus"]) =>
    users.create(
      makeUser({
        id,
        phone: `+9199990${id.length}${id.slice(-2)}`,
        displayName: id,
        role,
        kycStatus,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }),
    );

  beforeAll(async () => {
    process.on("unhandledRejection", (r) => rejections.push(r));
    client = new Redis(REDIS_URL, {
      db: REDIS_DB,
      keyPrefix: KEY_PREFIX,
    }) as unknown as RedisClient;
    janitor = new Redis(REDIS_URL, { db: REDIS_DB });
    // Fail loudly if the live instance isn't there: silently degrading would turn this whole
    // suite into a no-op, which is exactly the class of bug it exists to catch.
    await client.ping();
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    // ── identity (B11's durable source) ──────────────────────────────────────
    // The requester is deliberately `both` + verified: they would sail through the role/KYC
    // gate, so the only thing keeping them out of their own offer is the requesterId
    // exclusion. That is the case the audit found broken.
    await seedUser(REQUESTER, "both", "verified");
    await seedUser(HELPER_OK, "helper", "verified");
    await seedUser(HELPER_UNVERIFIED, "helper", "pending");
    await seedUser(HELPER_FAR, "helper", "verified");
    await seedUser(HELPER_ETA, "helper", "verified");

    // ── availability index: everyone publishes, so only the FILTERS can differ. ──
    await upsertHelperGeo(client, REQUESTER, 77.5949, 12.9718, FIXED_NOW);
    await upsertHelperGeo(client, HELPER_OK, 77.595, 12.972, FIXED_NOW);
    await upsertHelperGeo(client, HELPER_UNVERIFIED, 77.5943, 12.9713, FIXED_NOW);
    // ~55 km east: inside no sane radius, so never offered → never in the audience.
    await upsertHelperGeo(client, HELPER_FAR, 78.0946, 12.9716, FIXED_NOW);

    for (const userId of [REQUESTER, HELPER_OK, HELPER_UNVERIFIED, HELPER_FAR, HELPER_ETA]) {
      await writePresence(client, {
        userId,
        state: "online-available",
        activity: "idle",
        lastActiveAt: FIXED_NOW,
      });
    }

    await seedTask(T_ELIGIBILITY);
    await seedTask(T_ETA);
    await seedTask(T_ETA_FALLBACK);
    await seedTask(T_NOT_OFFERED);
    await seedTask(T_EXPIRED);
    await seedTask(T_DUPLICATE);
    await seedTask(T_SWEEP);
    await seedTask(T_NO_ACK);
    await seedTask(T_NO_ACK_ADVANCE, { helperId: HELPER_OK, state: "matched" });
    await seedTask(T_CANCEL_WHILE_SEARCHING);
    await seedTask(T_RACE_CLAIM);
    await seedTask(T_STALE_TIMER);
    await seedTask(T_STALE_HELPER);
    await seedTask(T_FRESH_HELPER);
    await seedTask(T_LOCKED, { helperId: HELPER_OK, state: "matched" });
    await seedTask(T_DELIST_WON);
    await seedTask(T_DELIST_SECOND);
    await seedTask(T_ROLES, { helperId: HELPER_OK, state: "matched" });
    await seedTask(T_CANCEL_BY_REQUESTER, { helperId: HELPER_OK, state: "matched" });
    await seedTask(T_CANCEL_BY_HELPER, { helperId: HELPER_OK, state: "matched" });

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
      helpers: createInMemoryHelperProfileRepo({
        [HELPER_OK]: {
          id: HELPER_OK,
          displayName: "Verified Helper",
          photoUrl: "",
          rating: 4.8,
          helpedCount: 12,
        },
      }),
      sos: createInMemorySosRepo(),
      users,
      now: () => clock,
    };
    io.of(NS.matching).use(authMiddleware);
    registerMatching(deps);

    await new Promise<void>((r) => httpServer.listen(0, r));
    const port = (httpServer.address() as AddressInfo).port;

    requester = await connect(port, REQUESTER, "both");
    helperOk = await connect(port, HELPER_OK, "helper");
    helperUnverified = await connect(port, HELPER_UNVERIFIED, "helper");
    helperFar = await connect(port, HELPER_FAR, "helper");
    helperEta = await connect(port, HELPER_ETA, "helper");

    const record = (userId: string, socket: AppClient): void => {
      socket.on("offer", (offer) => offers[userId]!.push(offer));
    };
    record(REQUESTER, requester);
    record(HELPER_OK, helperOk);
    record(HELPER_UNVERIFIED, helperUnverified);
    record(HELPER_FAR, helperFar);
    record(HELPER_ETA, helperEta);
    requester.on("helpers-nearby", (p) => nearby.push({ taskId: p.taskId, count: p.count }));
    helperOk.on("matched", (p) => matchedReveals.push(p));
    helperOk.on("offer-closed", (p) => offerClosed.push(p));
    requester.on("task-updated", (p) => taskUpdates.push(p));
  });

  afterAll(async () => {
    for (const c of [requester, helperOk, helperUnverified, helperFar, helperEta])
      c?.disconnect();
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    // Delete only OUR keys — never flushdb, which would take out whatever else is on db 15.
    const ours = await janitor.keys(`${KEY_PREFIX}*`);
    if (ours.length > 0) await janitor.del(...ours);
    await client.quit();
    await janitor.quit();
  });

  // ── B11 ────────────────────────────────────────────────────────────────────

  it("does not offer a task to its own requester, even when they are a verified helper", async () => {
    const ack = await requestHelp(requester, T_ELIGIBILITY);
    expect(ack).toEqual({ ok: true });
    await settle();

    // The requester publishes availability and is `both` + verified, so before B11 they
    // received (and could accept) their own request.
    expect(offers[REQUESTER]!.map((o) => o.taskId)).not.toContain(T_ELIGIBILITY);
    const audience = await client.smembers(keys.offerAudience(T_ELIGIBILITY));
    expect(audience).not.toContain(REQUESTER);
  });

  it("does not offer a task to a helper whose KYC is unverified", async () => {
    // Same broadcast as the case above — the unverified helper is nearer the origin than the
    // verified one, so distance cannot be what excluded them.
    expect(offers[HELPER_UNVERIFIED]!.map((o) => o.taskId)).not.toContain(T_ELIGIBILITY);
    const audience = await client.smembers(keys.offerAudience(T_ELIGIBILITY));
    expect(audience).not.toContain(HELPER_UNVERIFIED);
  });

  it("offers the task to the verified helper only, and counts exactly that audience", async () => {
    expect(offers[HELPER_OK]!.map((o) => o.taskId)).toContain(T_ELIGIBILITY);
    const audience = await client.smembers(keys.offerAudience(T_ELIGIBILITY));
    expect(audience).toEqual([HELPER_OK]);
    // `helpers-nearby` must agree with the audience, or the requester's radar lies about how
    // many people were actually reached.
    expect(nearby.find((n) => n.taskId === T_ELIGIBILITY)?.count).toBe(1);
  });

  // ── accept: offer validity ────────────────────────────────────────────────

  it("refuses an accept from a helper who was never in the offer audience", async () => {
    const ack = await requestHelp(requester, T_NOT_OFFERED);
    expect(ack).toEqual({ ok: true });
    await settle();

    // HELPER_FAR is a verified helper with a valid token who simply was not offered this
    // task. Before the audience check, knowing the taskId was enough to accept it — which
    // bypassed radius, presence, role AND KYC in one step.
    expect(offers[HELPER_FAR]!.map((o) => o.taskId)).not.toContain(T_NOT_OFFERED);
    const ackFar = await accept(helperFar, T_NOT_OFFERED);
    expect(ackFar.won).toBe(false);

    // Crucially the task is untouched, so the real audience can still win it.
    const task = await tasks.get(T_NOT_OFFERED);
    expect(task?.helperId).toBeNull();
    expect(task?.state).toBe("searching");
  });

  it("refuses an accept once the offer window has expired", async () => {
    const ack = await requestHelp(requester, T_EXPIRED);
    expect(ack).toEqual({ ok: true });
    await settle();
    expect(offers[HELPER_OK]!.map((o) => o.taskId)).toContain(T_EXPIRED);

    // Move the injected clock past expiresAt. `expiresAt` was previously sent to the client
    // and never enforced server-side, so a stale offer card could be accepted long after the
    // requester had given up.
    clock = FIXED_NOW + OFFER_WINDOW_MS + 1;
    const acceptAck = await accept(helperOk, T_EXPIRED);
    expect(acceptAck).toEqual({ won: false, reason: "expired" });

    const task = await tasks.get(T_EXPIRED);
    expect(task?.helperId).toBeNull();
    expect(task?.state).toBe("searching");
    clock = FIXED_NOW;
  });

  // ── A6 ────────────────────────────────────────────────────────────────────

  it("reveals a NON-NULL etaSeconds when tracking data exists for the task (A6)", async () => {
    // Tracking data for the TASK — the key matching must read. The old code passed the
    // helperId to `getTaskLocation`, whose key builder is `track:loc:<taskId>`, so it read a
    // key nothing ever writes and etaSeconds was null on every single match reveal.
    await setTaskLocation(client, T_ETA, {
      lat: 12.98,
      lng: 77.6,
      at: FIXED_NOW,
    });
    // Proof the old read could not have worked: there is no helper-keyed location, and
    // never was one, because nothing in the codebase writes that key.
    expect(await client.exists(keys.taskLocation(HELPER_OK))).toBe(0);

    const ack = await requestHelp(requester, T_ETA);
    expect(ack).toEqual({ ok: true });
    await settle();

    const acceptAck = await accept(helperOk, T_ETA);
    expect(acceptAck.won).toBe(true);

    const reveal = await withTimeout(
      new Promise<{ task: Task; helper: MatchedHelper }>((resolve) => {
        const existing = matchedReveals.find((m) => m.task.id === T_ETA);
        if (existing) return resolve(existing);
        helperOk.on("matched", (p) => {
          if (p.task.id === T_ETA) resolve(p);
        });
      }),
      3_000,
      "the matched reveal for the ETA task",
    );

    expect(reveal.helper.id).toBe(HELPER_OK);
    expect(reveal.helper.etaSeconds).not.toBeNull();
    expect(typeof reveal.helper.etaSeconds).toBe("number");
    expect(reveal.helper.etaSeconds!).toBeGreaterThan(0);

    // Pin the ETA to the TRACKED point specifically, not merely "non-null". The tracked fix
    // (12.98, 77.6) is ~1.1 km from the origin → ~787 s at the haversine fallback pace, while
    // the helper's availability fix is only ~62 m → ~44 s. Asserting the value is what proves
    // the tracked position won the fallback order rather than the ETA arriving by luck.
    expect(reveal.helper.etaSeconds!).toBeGreaterThan(600);
  });

  it("falls back to the helper's idle availability position when the task has no tracking data", async () => {
    // At match time there is usually NO task location: /tracking only starts writing once the
    // helper goes `en-route`. Returning null there is what made the A6 bug invisible, so the
    // fallback matters — the position that made this helper a candidate seconds ago is right
    // there in the geo index. This helper only joins the index now so the audience assertions
    // in the eligibility cases above stayed exact.
    await upsertHelperGeo(client, HELPER_ETA, 77.5951, 12.9721, FIXED_NOW);
    expect(await client.exists(keys.taskLocation(T_ETA_FALLBACK))).toBe(0);

    const ack = await requestHelp(requester, T_ETA_FALLBACK);
    expect(ack).toEqual({ ok: true });
    await settle();

    const reveal = new Promise<{ task: Task; helper: MatchedHelper }>((resolve) => {
      helperEta.on("matched", (p) => {
        if (p.task.id === T_ETA_FALLBACK) resolve(p);
      });
    });
    expect((await accept(helperEta, T_ETA_FALLBACK)).won).toBe(true);

    const { helper } = await withTimeout(reveal, 3_000, "the availability-ETA reveal");
    expect(helper.etaSeconds).not.toBeNull();
    // ~72 m from the origin: small, positive, and nothing like the tracked case above.
    expect(helper.etaSeconds!).toBeGreaterThan(0);
    expect(helper.etaSeconds!).toBeLessThan(300);
  });

  // ── B12: the shared role matrix ───────────────────────────────────────────

  it("refuses a requester's attempt to advance to `arrived`, and lets the helper do it", async () => {
    // Walk to en-route first — helper-driven, since it is a physical-progress claim.
    expect((await advance(requester, T_ROLES, "en-route")).ok).toBe(false);
    expect((await advance(helperOk, T_ROLES, "en-route")).ok).toBe(true);

    // The audit case verbatim: a requester could unilaterally declare the helper at the door.
    const refused = await advance(requester, T_ROLES, "arrived");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("not-allowed-for-role:requester->arrived");
    expect((await tasks.get(T_ROLES))?.state).toBe("en-route");

    const allowed = await advance(helperOk, T_ROLES, "arrived");
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.task.state).toBe("arrived");
  });

  it("refuses a helper's attempt to advance to `completed`, and lets the requester do it", async () => {
    expect((await advance(helperOk, T_ROLES, "in-progress")).ok).toBe(true);

    // The single most important edge in the matrix: a helper must not be able to close the
    // tracked / chattable / SOS-capable window on the vulnerable party's behalf.
    const refused = await advance(helperOk, T_ROLES, "completed");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("not-allowed-for-role:helper->completed");
    expect((await tasks.get(T_ROLES))?.state).toBe("in-progress");

    const allowed = await advance(requester, T_ROLES, "completed");
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.task.state).toBe("completed");
  });

  it("lets either party cancel", async () => {
    const byRequester = await advance(requester, T_CANCEL_BY_REQUESTER, "cancelled");
    expect(byRequester.ok).toBe(true);
    if (byRequester.ok) expect(byRequester.task.state).toBe("cancelled");

    const byHelper = await advance(helperOk, T_CANCEL_BY_HELPER, "cancelled");
    expect(byHelper.ok).toBe(true);
    if (byHelper.ok) expect(byHelper.task.state).toBe("cancelled");
  });

  it("still refuses a non-participant regardless of the target state", async () => {
    // helperFar is a legitimate authenticated user with no part in this task; the role matrix
    // is an addition to the participation check, never a replacement for it.
    const ack = await advance(helperFar, T_CANCEL_BY_HELPER, "cancelled");
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error).toBe("not-a-participant");
  });

  it("closes the outstanding offer when the requester cancels a still-searching task", async () => {
    await republishHelperOk();
    expect(await requestHelp(requester, T_CANCEL_WHILE_SEARCHING)).toEqual({ ok: true });
    await settle();
    expect(offers[HELPER_OK]!.map((o) => o.taskId)).toContain(T_CANCEL_WHILE_SEARCHING);

    // `searching -> cancelled` is legal, and the only edge a requester can drive with an offer
    // still out. `task-updated` reaches the two PARTICIPANTS — the offer audience are not
    // participants, so before this the helper's card stayed live for a withdrawn request until
    // the expiry sweep eventually mislabelled it `expired` up to a whole window later.
    const ack = await advance(requester, T_CANCEL_WHILE_SEARCHING, "cancelled");
    expect(ack.ok).toBe(true);

    const closure = await withTimeout(
      new Promise<{ taskId: string; reason: string }>((resolve) => {
        const tick = setInterval(() => {
          const hit = offerClosed.find((c) => c.taskId === T_CANCEL_WHILE_SEARCHING);
          if (hit) {
            clearInterval(tick);
            resolve(hit);
          }
        }, 25);
      }),
      3_000,
      "offer-closed for a cancelled search",
    );
    // `cancelled` is in the offer-closed contract for exactly this case; `expired` would be a
    // lie told a whole window late.
    expect(closure.reason).toBe("cancelled");
    // And the schedule is claimed, so the sweep cannot fan a second closure out for it.
    expect(await client.zscore(keys.offerExpiryQueue(), T_CANCEL_WHILE_SEARCHING)).toBeNull();
    expect(await client.exists(keys.offerAudience(T_CANCEL_WHILE_SEARCHING))).toBe(0);
    await settle(1_500);
    expect(offerClosed.filter((c) => c.taskId === T_CANCEL_WHILE_SEARCHING)).toHaveLength(1);
  });

  // ── acks are OPTIONAL on the wire ─────────────────────────────────────────
  // Every handler here types `ack` as required, but a type only binds code that imports it:
  // anything can put a frame on the socket without a callback and socket.io then invokes the
  // handler with `ack === undefined`. In `accept` and `advance-task` the ack fires AFTER the
  // durable write and BEFORE the broadcast, so the resulting `ack is not a function` throw
  // commits the state change and tells nobody — the exact write-then-drop failure that
  // ack-optional.test.ts pins for /chat. These own their own tasks because they deliberately
  // mutate task state without going through the normal acked path.

  it("reveals the match even when `accept` arrives with no ack callback", async () => {
    await republishHelperOk();
    expect(await requestHelp(requester, T_NO_ACK)).toEqual({ ok: true });
    await settle();
    expect(await client.sismember(keys.offerAudience(T_NO_ACK), HELPER_OK)).toBe(1);

    const reveal = new Promise<{ task: Task; helper: MatchedHelper }>((resolve) => {
      helperOk.on("matched", (p) => {
        if (p.task.id === T_NO_ACK) resolve(p);
      });
    });
    emitRaw(helperOk, "accept", { taskId: T_NO_ACK });

    // The task IS assigned either way — the bug is not in the write, it is that everything
    // after the ack was skipped, leaving a won match nobody was ever told about.
    await withTimeout(reveal, 3_000, "the matched reveal for an ack-less accept");
    // The schedule/audience cleanup runs AFTER the reveal emit, so let the tail of the handler
    // land before asserting on it.
    await settle();
    const task = await tasks.get(T_NO_ACK);
    expect(task?.helperId).toBe(HELPER_OK);
    // The post-ack cleanup must run too, or the sweep keeps a settled offer on its schedule.
    expect(await client.zscore(keys.offerExpiryQueue(), T_NO_ACK)).toBeNull();
    expect(await client.exists(keys.offerAudience(T_NO_ACK))).toBe(0);
    expect(rejections.map(String)).toEqual([]);
  });

  it("broadcasts `task-updated` even when `advance-task` arrives with no ack callback", async () => {
    emitRaw(helperOk, "advance-task", { taskId: T_NO_ACK_ADVANCE, to: "en-route" });
    await withTimeout(
      new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          if (taskUpdates.some((u) => u.task.id === T_NO_ACK_ADVANCE)) {
            clearInterval(tick);
            resolve();
          }
        }, 25);
      }),
      3_000,
      "task-updated from an ack-less advance",
    );
    expect((await tasks.get(T_NO_ACK_ADVANCE))?.state).toBe("en-route");
    expect(rejections.map(String)).toEqual([]);
  });

  it("refuses an ack-less INVALID payload via the error event instead of throwing", async () => {
    const errors: { code: string }[] = [];
    helperOk.on("error", (e) => errors.push(e));
    emitRaw(helperOk, "accept", { nope: true });
    emitRaw(helperOk, "advance-task", { taskId: T_NO_ACK_ADVANCE }); // no `to`
    emitRaw(helperOk, "request-help", {});
    await settle(300);
    expect(errors.map((e) => e.code)).toContain("INVALID_PAYLOAD");
    expect(rejections.map(String)).toEqual([]);
  });

  // ── C19: durable, idempotent offer expiry ─────────────────────────────────
  // These two cases own their own tasks and issue their own `request-help`, because any case
  // that moves the clock past a window lets the shared sweep collect every other live offer
  // in the process. Asserting on a task some earlier case had opened would make the result
  // depend on sweep timing rather than on behaviour.

  it("records the offer expiry durably and does not re-broadcast on a duplicate request-help", async () => {
    await republishHelperOk();
    expect(await requestHelp(requester, T_DUPLICATE)).toEqual({ ok: true });
    await settle();

    // The schedule lives in Redis, not in a setTimeout closure — which is the whole point:
    // before C19 a restart mid-window lost the only record that an offer was outstanding, so
    // the task sat in `searching` forever and every helper kept a dead offer card on screen.
    expect(Number(await client.zscore(keys.offerExpiryQueue(), T_DUPLICATE))).toBe(
      FIXED_NOW + OFFER_WINDOW_MS,
    );
    const before = offers[HELPER_OK]!.filter((o) => o.taskId === T_DUPLICATE).length;
    expect(before).toBe(1);

    // A duplicate request-help used to re-offer the task to the whole neighbourhood and arm a
    // second in-process timer racing the first over an audience the first had already deleted.
    expect(await requestHelp(requester, T_DUPLICATE)).toEqual({ ok: true });
    await settle();
    expect(offers[HELPER_OK]!.filter((o) => o.taskId === T_DUPLICATE).length).toBe(before);
    // ...and the original window is untouched, so a duplicate cannot extend an offer either.
    expect(Number(await client.zscore(keys.offerExpiryQueue(), T_DUPLICATE))).toBe(
      FIXED_NOW + OFFER_WINDOW_MS,
    );
  });

  it("closes a lapsed offer from the durable sweep, exactly once", async () => {
    await republishHelperOk();
    expect(await requestHelp(requester, T_SWEEP)).toEqual({ ok: true });
    await settle();
    expect(offers[HELPER_OK]!.map((o) => o.taskId)).toContain(T_SWEEP);

    // No timer of ours fires here: the in-process one is armed for OFFER_WINDOW_MS of REAL
    // time (60s), far beyond this test. The closure is observed purely because the sweep reads
    // the DURABLE schedule against the injected clock — which is exactly the property that
    // survives a restart.
    clock = FIXED_NOW + OFFER_WINDOW_MS + 1;
    await withTimeout(
      new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          if (offerClosed.some((c) => c.taskId === T_SWEEP)) {
            clearInterval(tick);
            resolve();
          }
        }, 25);
      }),
      6_000,
      "offer-closed from the durable expiry sweep",
    );

    expect(offerClosed.filter((c) => c.taskId === T_SWEEP)).toEqual([
      { taskId: T_SWEEP, reason: "expired" },
    ]);
    // The schedule entry is CLAIMED by whoever closes it, so no second sweep pass (nor another
    // instance, nor a stray in-process timer) can fan the same closure out again.
    expect(await client.zscore(keys.offerExpiryQueue(), T_SWEEP)).toBeNull();
    expect(await client.exists(keys.offerAudience(T_SWEEP))).toBe(0);

    // Give the sweep a couple more passes to prove the claim holds.
    await settle(2_500);
    expect(offerClosed.filter((c) => c.taskId === T_SWEEP)).toHaveLength(1);
    clock = FIXED_NOW;
  });

  it("claims a lapsed offer exactly once when TWO closers race the same entry", async () => {
    // The sweep case above passes even with a plain `zrem`: by the time a second closer could
    // act, `expireOffer` has already deleted the audience set, so its fan-out would reach nobody
    // and "exactly once" holds for the wrong reason. Here the two closers race while the audience
    // is still populated and the assertion is on the CLAIM's own return value, so only the claim
    // can be what makes it once. `claimLapsedOffer` is the real function `closeExpiredOffer`
    // calls — a test that re-implemented its Lua would only be evidence about the copy.
    await resetRequestHelpLimit();
    await republishHelperOk();
    expect(await requestHelp(requester, T_RACE_CLAIM)).toEqual({ ok: true });
    await settle();
    expect(await client.sismember(keys.offerAudience(T_RACE_CLAIM), HELPER_OK)).toBe(1);

    // Two claims issued with no await between them — what two instances sweeping the same due
    // entry, or a sweep racing the in-process timer, actually do.
    const lapsed = FIXED_NOW + OFFER_WINDOW_MS + 1;
    const claims = await Promise.all([
      claimLapsedOffer(client, T_RACE_CLAIM, lapsed),
      claimLapsedOffer(client, T_RACE_CLAIM, lapsed),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((c) => !c)).toHaveLength(1);

    // A third, long after: an entry that is simply gone is not claimable either, so a restarted
    // instance replaying its schedule cannot resurrect a closure.
    expect(await claimLapsedOffer(client, T_RACE_CLAIM, lapsed)).toBe(false);

    // The audience is untouched by a losing claim — that set is what the loser would have used
    // to fan a duplicate closure out, and what `accept` authorizes against.
    expect(await client.sismember(keys.offerAudience(T_RACE_CLAIM), HELPER_OK)).toBe(1);
    await client.del(keys.offerAudience(T_RACE_CLAIM));
  });

  it("refuses to claim an offer whose window has NOT lapsed, so a stale closer is a no-op", async () => {
    // `closeExpiredOffer`'s callers can arrive STALE — the sweep is a read-then-act batch (it
    // ZRANGEBYSCOREs everything due, then awaits a close per task, during which an entry later in
    // the batch can be closed and re-requested), and the in-process timer fires blind a whole
    // window after it was armed. A bare ZREM would claim the newer, LIVE entry: `expireOffer`
    // then fans `offer-closed` out and deletes the audience set, so every helper legitimately
    // offered the task is refused mid-window with "expired". The `score <= now` guard is what
    // makes that stale call do nothing.
    await resetRequestHelpLimit();
    await republishHelperOk();
    expect(await requestHelp(requester, T_STALE_TIMER)).toEqual({ ok: true });
    await settle();
    const live = Number(await client.zscore(keys.offerExpiryQueue(), T_STALE_TIMER));
    expect(live).toBe(FIXED_NOW + OFFER_WINDOW_MS);
    expect(await client.sismember(keys.offerAudience(T_STALE_TIMER), HELPER_OK)).toBe(1);
    const closuresBefore = offerClosed.filter((c) => c.taskId === T_STALE_TIMER).length;

    // The stale closer, at a `now` inside the live window.
    expect(await claimLapsedOffer(client, T_STALE_TIMER, FIXED_NOW)).toBe(false);
    // Boundary: one millisecond before expiry is still not lapsed.
    expect(await claimLapsedOffer(client, T_STALE_TIMER, live - 1)).toBe(false);

    // The live offer survives intact: schedule, audience, and no closure on the wire.
    expect(Number(await client.zscore(keys.offerExpiryQueue(), T_STALE_TIMER))).toBe(live);
    expect(await client.sismember(keys.offerAudience(T_STALE_TIMER), HELPER_OK)).toBe(1);
    await settle(1_200); // several real sweep passes, none of which is due yet
    expect(offerClosed.filter((c) => c.taskId === T_STALE_TIMER)).toHaveLength(closuresBefore);

    // Now let it lapse for real: the SAME claim must fire, or the guard would be suppressing
    // everything and this test would pass for the wrong reason.
    clock = FIXED_NOW + OFFER_WINDOW_MS + 1;
    await withTimeout(
      new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          if (offerClosed.some((c) => c.taskId === T_STALE_TIMER)) {
            clearInterval(tick);
            resolve();
          }
        }, 25);
      }),
      6_000,
      "offer-closed once the window genuinely lapses",
    );
    clock = FIXED_NOW;
  });

  // ── the winner stops being a candidate ─────────────────────────────────────

  it("de-lists the winning helper, so a busy helper is not offered a SECOND task", async () => {
    // Nothing used to do this. The only de-list lived in /tracking's `location` handler, gated
    // on `en-route`/`arrived` — states a freshly-matched helper has not reached. So between
    // winning a task and physically setting off (a real interval: reading the card, deciding,
    // finding shoes) the helper stayed in `geo:helpers` with a FRESH timestamp and was a
    // first-class candidate for the next search. Accepting the second offer would strand one of
    // the two requesters, and for this user base that is someone waiting alone for medicine.
    await resetRequestHelpLimit();
    await republishHelperOk();
    expect(await inGeoIndex(HELPER_OK)).toBe(true);

    expect(await requestHelp(requester, T_DELIST_WON)).toEqual({ ok: true });
    await settle();
    expect(await client.sismember(keys.offerAudience(T_DELIST_WON), HELPER_OK)).toBe(1);
    expect((await accept(helperOk, T_DELIST_WON)).won).toBe(true);

    // BOTH halves of the availability index are gone — the GEO member and its freshness score.
    // Leaving either behind would matter: a stale-but-present GEO member is what the freshness
    // intersection exists to catch, and a freshness score with no GEO member is a leak.
    expect(await client.zscore(keys.helperGeo(), HELPER_OK)).toBeNull();
    expect(await client.zscore(keys.helperGeoFresh(), HELPER_OK)).toBeNull();
    expect(await inGeoIndex(HELPER_OK)).toBe(false);

    // The observable consequence: the next search does not reach them. Note this helper is
    // still `online-available` and still KYC-verified — only the de-list excludes them.
    const presence = await client.hgetall(keys.presence(HELPER_OK));
    expect(presence.state).toBe("online-available");
    const before = offers[HELPER_OK]!.length;
    await resetRequestHelpLimit();
    expect(await requestHelp(requester, T_DELIST_SECOND)).toEqual({ ok: true });
    await settle();
    expect(offers[HELPER_OK]!).toHaveLength(before);
    expect(await client.smembers(keys.offerAudience(T_DELIST_SECOND))).not.toContain(HELPER_OK);
    expect(nearby.find((n) => n.taskId === T_DELIST_SECOND)?.count).toBe(0);
  });

  // ── A1/B9: the freshness intersection in findEligibleHelpers ───────────────

  it("does not offer work to a helper whose availability publish has gone stale", async () => {
    // Redis GEO members have no per-member TTL, so `geo:helpers` alone remembers a helper who
    // closed their laptop days ago. The freshness zset is what expresses decay, and
    // `findEligibleHelpers` intersects the two. Without the intersection this helper — still a
    // GEOSEARCH hit, still `online-available`, still verified — would be offered the task, and
    // the requester's radar would count a phantom who can never accept.
    await seedUser(HELPER_STALE, "helper", "verified");
    await writePresence(client, {
      userId: HELPER_STALE,
      state: "online-available",
      activity: "idle",
      lastActiveAt: FIXED_NOW,
    });
    // Published one millisecond outside the TTL window: near the origin, so distance cannot be
    // what excludes them, and only just stale, so the boundary itself is under test.
    await upsertHelperGeo(
      client,
      HELPER_STALE,
      77.5947,
      12.9717,
      FIXED_NOW - AVAILABILITY_TTL_MS - 1,
    );
    // Present in the GEO half of the index — that is the premise of the whole case.
    const hits = (await client.geosearch(
      keys.helperGeo(),
      "FROMLONLAT",
      ORIGIN.lng,
      ORIGIN.lat,
      "BYRADIUS",
      config.match.radiusMeters,
      "m",
      "ASC",
    )) as string[];
    expect(hits).toContain(HELPER_STALE);

    await resetRequestHelpLimit();
    await republishHelperOk();
    expect(await requestHelp(requester, T_STALE_HELPER)).toEqual({ ok: true });
    await settle();

    const audience = await client.smembers(keys.offerAudience(T_STALE_HELPER));
    expect(audience).not.toContain(HELPER_STALE);
    // The fresh helper still gets it, so "nobody was offered anything" cannot be the reason.
    expect(audience).toContain(HELPER_OK);
    expect(nearby.find((n) => n.taskId === T_STALE_HELPER)?.count).toBe(1);

    // Same helper, same position, freshly stamped → now offerable. This is what pins the
    // exclusion on staleness specifically rather than on anything else about the identity.
    await upsertHelperGeo(client, HELPER_STALE, 77.5947, 12.9717, clock);
    await resetRequestHelpLimit();
    await republishHelperOk();
    expect(await requestHelp(requester, T_FRESH_HELPER)).toEqual({ ok: true });
    await settle();
    expect(await client.smembers(keys.offerAudience(T_FRESH_HELPER))).toContain(HELPER_STALE);
  });

  // ── B12b: advance-task holds the match lock ───────────────────────────────

  it("refuses an advance while the match lock is held elsewhere, instead of writing through it", async () => {
    // `advance-task` used to read, validate, then write with no lock, so two concurrent
    // advances (or one racing the accept flow) could both validate against the same stale state
    // and interleave. It now takes the SAME lock `accept` does. Holding that lock from outside
    // the process is how another instance mid-transition looks from here.
    const held = await acquireLock(client, keys.matchLock(T_LOCKED), "someone-else", 5_000);
    expect(held).not.toBeNull();

    const errors: { code: string; message: string }[] = [];
    helperOk.on("error", (e) => errors.push(e));

    const refused = await advance(helperOk, T_LOCKED, "en-route");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("task-busy");
    // Refusing must be loud: the client's retry decision depends on knowing this was contention
    // and not an illegal transition.
    expect(errors.some((e) => e.message.includes("retry"))).toBe(true);

    // THE POINT: the write did not happen. An unlocked handler would have validated
    // `matched -> en-route` happily and committed it.
    expect((await tasks.get(T_LOCKED))?.state).toBe("matched");
    expect(taskUpdates.some((u) => u.task.id === T_LOCKED)).toBe(false);

    // Release and confirm the very same advance now succeeds — otherwise "refused" could just
    // mean the transition was never legal.
    await releaseLock(client, held!);
    const allowed = await advance(helperOk, T_LOCKED, "en-route");
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.task.state).toBe("en-route");
  });
});
