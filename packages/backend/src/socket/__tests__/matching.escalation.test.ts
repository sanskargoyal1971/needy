import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  makeTask,
  NS,
  type LatLng,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type MatchOffer,
} from "@needy/shared";
import { keys } from "../../domain/keys.js";
import { config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { makeUser } from "../../auth/types.js";
import type { Deps } from "../../domain/deps.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { upsertHelperGeo } from "../../domain/location-store.js";
import { writePresence } from "../../domain/presence-store.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import type { Logger } from "../../logger.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import { createInMemoryServiceCatalog } from "../../services/catalog.js";
import { safetyDeps } from "../../test/safetyDeps.js";
import { authMiddleware } from "../auth.js";
import { registerMatching } from "../matching.js";

/** ── Radius escalation, the eligibility matrix, and the service filter ─────
 *  Against a REAL Redis, because every behaviour here is a GEOSEARCH result: a mock that
 *  returns whatever it was told would prove only that the mock agrees with itself, and
 *  "is this helper within 1 km" is precisely the question under test.
 *
 *  The geography (all bearings due east of the origin, which keeps the maths obvious):
 *    NEAR  ~0.4 km — inside wave 0
 *    MID   ~3   km — inside wave 1, outside wave 0
 *    FAR   ~8   km — inside wave 2, outside wave 1
 *    OUTER ~30  km — outside every wave
 */

type MatchSocket = ClientSocket<MatchingServerEvents, MatchingClientEvents>;

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const KEY_PREFIX = `test:matching-escalation:${process.pid}:${Date.now()}:`;
const FIXED_NOW = 1_700_000_000_000;
const OFFER_WINDOW_MS = 400;

const ORIGIN: LatLng = { lat: 12.9716, lng: 77.5946 };
/** Degrees of longitude per km at this latitude (cos(12.97°) ≈ 0.9745). */
const KM = 1 / (111.32 * 0.9745);
const eastOf = (km: number): LatLng => ({ lat: ORIGIN.lat, lng: ORIGIN.lng + km * KM });

const REQUESTER = "esc-req";
const NEAR = "esc-helper-near";
const MID = "esc-helper-mid";
const FAR = "esc-helper-far";
const OUTER = "esc-helper-outer";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let clock = FIXED_NOW;

function connect(port: number, userId: string): Promise<MatchSocket> {
  const token = signAccessToken({
    sub: userId,
    role: "both",
    displayName: userId,
    kyc: "verified",
  });
  const socket: MatchSocket = ioClient(`http://localhost:${port}${NS.matching}`, {
    transports: ["websocket"],
    auth: { token },
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

/** Collect every `offer` a socket receives, so an assertion can be "was this helper ever
 *  offered the task" rather than "did they get it in this particular instant". */
function collectOffers(socket: MatchSocket): MatchOffer[] {
  const seen: MatchOffer[] = [];
  socket.on("offer", (o) => seen.push(o as MatchOffer));
  return seen;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("matching: radius escalation, eligibility and service filters", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let redisRaw: Redis;
  let client: RedisClient;
  let deps: Deps;
  let port: number;

  const tasks = createInMemoryTaskRepo();
  const users = createInMemoryUserRepo();
  const services = createInMemoryServiceCatalog();
  const exceptions = createInMemoryExceptionRepo();

  const sockets: MatchSocket[] = [];

  /** An adult (36-59) of the given gender: the band the matrix never restricts, so a test
   *  that is not about eligibility does not accidentally depend on it. */
  const adult = (id: string, gender: "male" | "female" = "male") =>
    users.create(
      makeUser({
        id,
        phone: `+9198${id.length}${Math.abs(hash(id)) % 100000000}`.slice(0, 13),
        displayName: id,
        role: "both",
        kycStatus: "verified",
        onboardingStatus: "approved",
        dateOfBirth: "1985-06-15",
        gender,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }),
    );

  const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

  async function publish(helperId: string, at: LatLng) {
    await upsertHelperGeo(client, helperId, at.lng, at.lat, clock);
    await writePresence(client, {
      userId: helperId,
      state: "online-available",
      activity: "idle",
      lastActiveAt: clock,
    });
  }

  async function newSearch(taskId: string, serviceCode: string | null = null) {
    await tasks.create({
      id: taskId,
      requesterId: REQUESTER,
      helperId: null,
      category: "errand",
      state: "searching",
      origin: ORIGIN,
      title: "Pick up medicine",
      description: "test",
      price: 149,
      serviceCode,
      scheduledFor: null,
      serviceBrief: null,
      handoffOtpHash: null,
      handoffOtpExpiresAt: null,
      handoffVerifiedAt: null,
      createdAt: clock,
      updatedAt: clock,
    });
  }

  beforeAll(async () => {
    redisRaw = new Redis(REDIS_URL, { keyPrefix: KEY_PREFIX, db: 14 });
    await redisRaw.flushdb();
    client = redisRaw as unknown as RedisClient;
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    await adult(REQUESTER);
    for (const id of [NEAR, MID, FAR, OUTER]) await adult(id);

    // Every helper offers the mandatory hospital service; only NEAR also does groceries.
    for (const id of [NEAR, MID, FAR, OUTER]) await services.setHelperServices(id, [], clock);
    await services.setHelperServices(NEAR, ["groceries"], clock);

    httpServer = createServer();
    io = new IOServer(httpServer);
    deps = {
      io,
      redis,
      logger: silentLogger,
      config: {
        ...config,
        match: {
          ...config.match,
          offerWindowMs: OFFER_WINDOW_MS,
          radiusWavesMeters: [1_000, 5_000, 10_000],
          radiusMeters: 10_000,
        },
      },
      tasks,
      messages: createInMemoryMessageRepo(),
      helpers: createInMemoryHelperProfileRepo(),
      sos: createInMemorySosRepo(),
      users,
      services,
      exceptions,
      ...safetyDeps(),
      now: () => clock,
    };
    io.of(NS.matching).use(authMiddleware);
    registerMatching(deps);

    await new Promise<void>((r) => httpServer.listen(0, r));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    // `io.close()` returns a promise in socket.io 4.7+. Awaiting it matters here: the sweep
    // interval registered by registerMatching is cleared on close, and leaving it running
    // would keep hitting a Redis connection this teardown is about to quit.
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await redisRaw.flushdb();
    await redisRaw.quit();
  });

  async function openSockets(ids: string[]): Promise<Record<string, MatchSocket>> {
    const out: Record<string, MatchSocket> = {};
    for (const id of ids) {
      const s = await connect(port, id);
      sockets.push(s);
      out[id] = s;
    }
    return out;
  }

  it("offers the innermost ring first, then widens only when nobody accepts", async () => {
    await publish(NEAR, eastOf(0.4));
    await publish(MID, eastOf(3));
    await publish(FAR, eastOf(8));
    await publish(OUTER, eastOf(30));

    const s = await openSockets([REQUESTER, NEAR, MID, FAR, OUTER]);
    const nearOffers = collectOffers(s[NEAR]!);
    const midOffers = collectOffers(s[MID]!);
    const farOffers = collectOffers(s[FAR]!);
    const outerOffers = collectOffers(s[OUTER]!);

    const taskId = "esc-task-waves";
    await newSearch(taskId);
    await new Promise<void>((r) => s[REQUESTER]!.emit("request-help", { taskId }, () => r()));

    // Wave 0 — only the 400 m helper. This is the whole point: the nearest helper gets first
    // refusal rather than the whole city racing for a job next door to someone else.
    await sleep(150);
    expect(nearOffers.length, "near should be offered immediately").toBeGreaterThan(0);

    // An offer goes to people who will mostly never take the task, so it carries a rough
    // place and a rounded distance — not the requester's coordinates. ORIGIN has four decimal
    // places; an offer that echoed it would compare equal here.
    const offered = nearOffers[0]!;
    expect(offered.origin).not.toEqual(ORIGIN);
    expect(offered.origin.lat).toBeCloseTo(ORIGIN.lat, 2);
    expect(offered.origin.lat).toBe(Math.round(ORIGIN.lat * 1000) / 1000);
    expect(offered.distanceMeters % 100).toBe(0);
    expect(midOffers, "mid is outside 1km on wave 0").toHaveLength(0);
    expect(farOffers).toHaveLength(0);

    // Let wave 0 lapse. The sweep escalates rather than closing.
    clock += OFFER_WINDOW_MS + 50;
    await sleep(1_400);
    expect(midOffers.length, "mid should be reached once the search widens to 5km").toBeGreaterThan(
      0,
    );
    expect(farOffers, "far is still outside 5km").toHaveLength(0);

    // Wave 2 — out to the 10 km cap.
    clock += OFFER_WINDOW_MS + 50;
    await sleep(1_400);
    expect(farOffers.length, "far should be reached at 10km").toBeGreaterThan(0);

    // The cap is a cap. Nothing widens past it, however long the search runs.
    expect(outerOffers, "30km is beyond the hard ceiling").toHaveLength(0);
  }, 20_000);

  it("closes the offer for real once the outermost ring lapses", async () => {
    // Its own requester/helper pair, published fresh: this case walks the whole ladder and
    // must not depend on what an earlier case left in the geo index.
    const R = "esc-close-req";
    const H = "esc-close-helper";
    await adult(R);
    await adult(H);
    await services.setHelperServices(H, [], clock);
    await publish(H, eastOf(0.4));

    const s = await openSockets([R, H]);
    const closed: { taskId: string; reason: string }[] = [];
    s[H]!.on("offer-closed", (p) => closed.push(p as { taskId: string; reason: string }));
    const requesterSaw: string[] = [];
    s[R]!.on("task-updated", (p) => requesterSaw.push(p.task.state));

    const taskId = "esc-task-close";
    await tasks.create(
      makeTask({
        id: taskId,
        requesterId: R,
        category: "errand",
        state: "searching",
        origin: ORIGIN,
        title: "x",
        createdAt: clock,
        updatedAt: clock,
      }),
    );
    await new Promise<void>((r) => s[R]!.emit("request-help", { taskId }, () => r()));

    // Walk past every wave. Poll rather than sleeping a fixed amount: the sweep runs on a
    // real-time interval while the offer window is measured on the injected clock, so a fixed
    // sleep is a race that fails on a loaded machine and proves nothing when it passes.
    const deadline = Date.now() + 12_000;
    while (closed.length === 0 && Date.now() < deadline) {
      clock += OFFER_WINDOW_MS + 50;
      await sleep(250);
    }

    // Exactly one closure, and only after the outermost ring — a requester whose search is
    // still widening must never be told it ended.
    expect(closed.filter((c) => c.taskId === taskId)).toHaveLength(1);
    expect(closed[0]?.reason).toBe("expired");

    // And the search ends for the requester as well. It used to stay `searching` for ever:
    // the helpers were told the offer had closed and the person who asked was told nothing.
    await sleep(100);
    expect((await tasks.get(taskId))?.state).toBe("unmatched");
    expect(requesterSaw).toEqual(["unmatched"]);

    // A closed search cannot be reopened by re-sending request-help.
    const again = await new Promise<{ ok: boolean }>((r) =>
      s[R]!.emit("request-help", { taskId }, (res) => r(res)),
    );
    expect(again.ok).toBe(false);
  }, 25_000);

  it("does not offer a task to a helper who does not provide that service", async () => {
    const A = "esc-svc-a";
    const B = "esc-svc-b";
    await adult(A);
    await adult(B);
    await services.setHelperServices(A, ["groceries"], clock);
    await services.setHelperServices(B, [], clock); // hospital only (mandatory)
    await publish(A, eastOf(0.3));
    await publish(B, eastOf(0.3));

    const s = await openSockets([A, B]);
    const aOffers = collectOffers(s[A]!);
    const bOffers = collectOffers(s[B]!);

    const taskId = "esc-task-service";
    await newSearch(taskId, "groceries");
    const req = await openSockets([REQUESTER]);
    await new Promise<void>((r) => req[REQUESTER]!.emit("request-help", { taskId }, () => r()));
    await sleep(200);

    expect(aOffers.some((o) => o.taskId === taskId)).toBe(true);
    expect(bOffers.some((o) => o.taskId === taskId)).toBe(false);
  }, 15_000);

  /** Hospital accompaniment is mandatory for every helper, so the emergency pool is never
   *  narrowed by the service filter. This is the regression that would matter most. */
  it("reaches every nearby helper for the mandatory hospital service", async () => {
    const A = "esc-hosp-a";
    const B = "esc-hosp-b";
    await adult(A);
    await adult(B);
    await services.setHelperServices(A, ["groceries"], clock);
    await services.setHelperServices(B, [], clock);
    await publish(A, eastOf(0.3));
    await publish(B, eastOf(0.3));

    const s = await openSockets([A, B]);
    const aOffers = collectOffers(s[A]!);
    const bOffers = collectOffers(s[B]!);

    const taskId = "esc-task-hospital";
    await newSearch(taskId, "hospital");
    const req = await openSockets([REQUESTER]);
    await new Promise<void>((r) => req[REQUESTER]!.emit("request-help", { taskId }, () => r()));
    await sleep(200);

    expect(
      aOffers.some((o) => o.taskId === taskId),
      "A must get hospital work",
    ).toBe(true);
    expect(
      bOffers.some((o) => o.taskId === taskId),
      "B must get hospital work",
    ).toBe(true);
  }, 15_000);

  /** The safety matrix, enforced where the offer is made. A young man's request must not be
   *  broadcast to a young woman even though she is the nearest available helper. */
  it("does not live-dispatch a restricted pairing", async () => {
    const YOUNG_M = "esc-young-m";
    const YOUNG_F = "esc-young-f";
    const OLDER_F = "esc-older-f";
    await users.create(
      makeUser({
        id: YOUNG_M,
        phone: "+919700000001",
        displayName: YOUNG_M,
        role: "both",
        kycStatus: "verified",
        onboardingStatus: "approved",
        dateOfBirth: "2001-01-01",
        gender: "male",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }),
    );
    await users.create(
      makeUser({
        id: YOUNG_F,
        phone: "+919700000002",
        displayName: YOUNG_F,
        role: "both",
        kycStatus: "verified",
        onboardingStatus: "approved",
        dateOfBirth: "2001-01-01",
        gender: "female",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }),
    );
    await adult(OLDER_F, "female"); // 40s — outside the restricted band, so allowed
    await services.setHelperServices(YOUNG_F, [], clock);
    await services.setHelperServices(OLDER_F, [], clock);
    await publish(YOUNG_F, eastOf(0.2));
    await publish(OLDER_F, eastOf(0.3));

    const s = await openSockets([YOUNG_M, YOUNG_F, OLDER_F]);
    const restricted = collectOffers(s[YOUNG_F]!);
    const permitted = collectOffers(s[OLDER_F]!);

    const taskId = "esc-task-matrix";
    await tasks.create({
      id: taskId,
      requesterId: YOUNG_M,
      helperId: null,
      category: "errand",
      state: "searching",
      origin: ORIGIN,
      title: "x",
      description: "t",
      price: 149,
      serviceCode: "hospital",
      scheduledFor: null,
      serviceBrief: null,
      handoffOtpHash: null,
      handoffOtpExpiresAt: null,
      handoffVerifiedAt: null,
      createdAt: clock,
      updatedAt: clock,
    });
    await new Promise<void>((r) => s[YOUNG_M]!.emit("request-help", { taskId }, () => r()));
    await sleep(250);

    expect(
      restricted.some((o) => o.taskId === taskId),
      "a young woman must not be live-dispatched a young man's request",
    ).toBe(false);
    expect(
      permitted.some((o) => o.taskId === taskId),
      "an older helper is unaffected by the restriction",
    ).toBe(true);
  }, 15_000);

  /**
   * A refusal the requester cannot see is the worst of both worlds.
   *
   * Reported live: a young man's search found the only nearby helper — a young woman two
   * metres away — filtered her out correctly, and then told him "asking helpers closest to
   * you first" forever. An empty neighbourhood and a deliberate refusal were indistinguishable
   * on screen, so there was nothing to act on and no reason given.
   *
   * The count, and ONLY the count. Naming or placing these helpers would leak precisely what
   * the rule exists to withhold.
   */
  it("tells the requester when the only nearby helpers were refused by the matrix", async () => {
    const YOUNG_M = "esc-nearby-m";
    const YOUNG_F = "esc-nearby-f";
    await users.create(
      makeUser({
        id: YOUNG_M,
        phone: "+919700000011",
        displayName: YOUNG_M,
        role: "both",
        kycStatus: "verified",
        onboardingStatus: "approved",
        dateOfBirth: "2001-01-01",
        gender: "male",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }),
    );
    await users.create(
      makeUser({
        id: YOUNG_F,
        phone: "+919700000012",
        displayName: YOUNG_F,
        role: "both",
        kycStatus: "verified",
        onboardingStatus: "approved",
        dateOfBirth: "2001-01-01",
        gender: "female",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }),
    );
    // Earlier cases in this file leave their own helpers in the shared availability index, and
    // this assertion is about a neighbourhood containing exactly ONE refused helper. Clearing
    // both halves of the index is the only way to state that precisely.
    await client.del(keys.helperGeo());
    await client.del(keys.helperGeoFresh());

    await services.setHelperServices(YOUNG_F, [], clock);
    await publish(YOUNG_F, eastOf(0.2));

    const s = await openSockets([YOUNG_M, YOUNG_F]);
    const nearby: { count: number; restrictedNearby?: number }[] = [];
    s[YOUNG_M]!.on("helpers-nearby", (p) => nearby.push(p));

    const taskId = "esc-task-nearby-refused";
    await tasks.create({
      id: taskId,
      requesterId: YOUNG_M,
      helperId: null,
      category: "errand",
      state: "searching",
      origin: ORIGIN,
      title: "x",
      description: "t",
      price: 149,
      serviceCode: "hospital",
      scheduledFor: null,
      serviceBrief: null,
      handoffOtpHash: null,
      handoffOtpExpiresAt: null,
      handoffVerifiedAt: null,
      createdAt: clock,
      updatedAt: clock,
    });
    await new Promise<void>((r) => s[YOUNG_M]!.emit("request-help", { taskId }, () => r()));
    await sleep(250);

    const first = nearby[0];
    expect(first, "the requester must be told how the search went").toBeDefined();
    expect(first!.count, "nobody was offered the task").toBe(0);
    expect(
      first!.restrictedNearby,
      "…but the requester is told someone was there and was refused",
    ).toBe(1);
  }, 15_000);
});
