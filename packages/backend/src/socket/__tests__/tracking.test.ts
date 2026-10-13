import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  NS,
  type LocationUpdate,
  type SocketErrorPayload,
  type TaskState,
  type TrackingClientEvents,
  type TrackingServerEvents,
} from "@needy/shared";
import { config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import type { Deps } from "../../domain/deps.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import type { Logger } from "../../logger.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { createInMemoryServiceCatalog } from "../../services/catalog.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { safetyDeps } from "../../test/safetyDeps.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
  type TaskRepository,
} from "../../domain/stores.js";
import { keys } from "../../domain/keys.js";
import { getTaskLocation, upsertHelperGeo } from "../../domain/location-store.js";
import { authMiddleware } from "../auth.js";
import { registerTracking } from "../tracking.js";

/**
 * ── /tracking guards (§2.3) ──────────────────────────────────────────────────
 * Drives the REAL registerTracking over a real socket.io server and a real ioredis against
 * localhost (per-run key prefix, so it neither collides with a dev instance nor with a
 * sibling test file). Real Redis matters here specifically: the audited bug was raw client
 * coordinates reaching `geoadd`, and the proof is that nothing lands in Redis — which a mock
 * that silently accepts NaN could not demonstrate.
 *
 * Covers: only the assigned HELPER may post position (a requester cannot), payload validation
 * (audit B7 — NaN / out-of-range never reach Redis), and the live-tracking state gate.
 */

type AppClient = ClientSocket<TrackingServerEvents, TrackingClientEvents>;

const TASK_ID = "task-track-1";
const REQUESTER_ID = "req-track-1";
const HELPER_ID = "helper-track-1";
const STRANGER_ID = "stranger-track-9";

const ORIGIN = { lat: 12.9716, lng: 77.5946 };
const NEARBY = { lat: 12.9725, lng: 77.5951 };
const FIXED_NOW = 1_700_000_000_000;
const KEY_PREFIX = `test:tracking:${process.pid}:`;

/** Advancing injected clock: the location bucket refills from elapsed time, so a frozen
 *  clock would make later cases fail with RATE_LIMITED instead of the reason under test. */
let clockNow = FIXED_NOW;

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function connect(port: number, userId: string): Promise<AppClient> {
  const token = signAccessToken({
    sub: userId,
    role: "both",
    displayName: userId,
    kyc: "verified",
  });
  const socket: AppClient = ioClient(`http://localhost:${port}${NS.tracking}`, {
    transports: ["websocket"],
    auth: { token },
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

/** `location` has no ack in the contract, so a refusal MUST arrive as an `error` event —
 *  a timeout here means the server silently dropped the payload, which is itself the bug. */
function nextError(socket: AppClient, ms = 3_000): Promise<SocketErrorPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for an error event")), ms);
    socket.once("error", (payload) => {
      clearTimeout(timer);
      resolve(payload as SocketErrorPayload);
    });
  });
}

/** Emit `location` with an arbitrary payload; client-side typing is bypassed deliberately
 *  because the point is that the SERVER must not trust the wire. */
function emitLocation(socket: AppClient, payload: unknown): void {
  (socket as unknown as { emit: (e: string, p: unknown) => void }).emit("location", payload);
}

const tick = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("/tracking location guards (§2.3)", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let redisRaw: Redis;
  let client: RedisClient;
  let helper: AppClient;
  let requester: AppClient;
  let stranger: AppClient;
  let tasks: TaskRepository;

  /** Move the task into `state` directly through the repo — this suite is about /tracking's
   *  gate, not about the advance-task flow that /matching owns. */
  const setState = async (state: TaskState): Promise<void> => {
    await tasks.update(TASK_ID, { state, updatedAt: clockNow });
  };

  beforeAll(async () => {
    redisRaw = new Redis(config.redisUrl, { keyPrefix: KEY_PREFIX });
    client = redisRaw as unknown as RedisClient;
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    tasks = createInMemoryTaskRepo();
    await tasks.create({
      id: TASK_ID,
      requesterId: REQUESTER_ID,
      helperId: HELPER_ID,
      category: "errand",
      state: "en-route",
      origin: ORIGIN,
      title: "Pick up medicine",
      description: "test",
      price: 100,
      serviceCode: null,
      scheduledFor: null,
      serviceBrief: null,
      handoffOtpHash: null,
      handoffOtpExpiresAt: null,
      handoffVerifiedAt: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });

    httpServer = createServer();
    io = new IOServer(httpServer);
    const deps: Deps = {
      io,
      redis,
      logger: silentLogger,
      config,
      tasks,
      messages: createInMemoryMessageRepo(),
      helpers: createInMemoryHelperProfileRepo(),
      sos: createInMemorySosRepo(),
      users: createInMemoryUserRepo(),
      services: createInMemoryServiceCatalog(),
      exceptions: createInMemoryExceptionRepo(),
      ...safetyDeps(),
      now: () => clockNow,
    };
    io.of(NS.tracking).use(authMiddleware);
    registerTracking(deps);

    await new Promise<void>((r) => httpServer.listen(0, r));
    const port = (httpServer.address() as AddressInfo).port;

    helper = await connect(port, HELPER_ID);
    requester = await connect(port, REQUESTER_ID);
    stranger = await connect(port, STRANGER_ID);
  });

  afterAll(async () => {
    for (const c of [helper, requester, stranger]) c?.disconnect();
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    // Only OUR prefixed keys, so a shared dev Redis survives. `keys` returns them WITH the
    // prefix while `del` re-applies it, hence the slice.
    const found = await redisRaw.keys(`${KEY_PREFIX}*`);
    if (found.length > 0) {
      await redisRaw.del(...found.map((k) => k.slice(KEY_PREFIX.length)));
    }
    redisRaw.disconnect();
  });

  beforeEach(async () => {
    clockNow += 60_000;
    // Clear the stored position between cases so "nothing reached Redis" is an honest
    // assertion rather than an artefact of a previous test's write.
    await client.del(keys.taskLocation(TASK_ID));
    await setState("en-route");
  });

  it("accepts a location from the assigned helper in a tracking state", async () => {
    helper.emit("join", { taskId: TASK_ID });
    requester.emit("join", { taskId: TASK_ID });
    await tick();

    const moved = new Promise<{ taskId: string; update: LocationUpdate }>((resolve) =>
      requester.once("helper-moved", resolve),
    );
    const eta = new Promise<{ etaSeconds: number; distanceMeters: number }>((resolve) =>
      requester.once("eta", resolve),
    );

    emitLocation(helper, { taskId: TASK_ID, point: NEARBY, heading: 90, speedMps: 1.4 });

    const relayed = await moved;
    expect(relayed.taskId).toBe(TASK_ID);
    expect(relayed.update.lat).toBeCloseTo(NEARBY.lat, 6);
    expect(relayed.update.lng).toBeCloseTo(NEARBY.lng, 6);
    // Server-stamped from the injected clock, never from the client's payload.
    expect(relayed.update.at).toBe(clockNow);

    const computed = await eta;
    expect(computed.distanceMeters).toBeGreaterThan(0);

    const stored = await getTaskLocation(client, TASK_ID);
    expect(stored?.lat).toBeCloseTo(NEARBY.lat, 6);
    expect(stored?.at).toBe(clockNow);
  });

  it("refuses a location from the REQUESTER — only the assigned helper reports position", async () => {
    const errored = nextError(requester);
    emitLocation(requester, { taskId: TASK_ID, point: NEARBY });

    const err = await errored;
    expect(err.code).toBe("NOT_TASK_HELPER");
    expect(err.event).toBe("location");

    await tick();
    // A requester's own position must never become the task's tracked helper position.
    expect(await getTaskLocation(client, TASK_ID)).toBeNull();
  });

  it("refuses a location from a non-participant", async () => {
    const errored = nextError(stranger);
    emitLocation(stranger, { taskId: TASK_ID, point: NEARBY });

    expect((await errored).code).toBe("NOT_A_PARTICIPANT");
    await tick();
    expect(await getTaskLocation(client, TASK_ID)).toBeNull();
  });

  it("refuses NaN / Infinity / out-of-range / non-numeric coordinates and never writes them to Redis (audit B7)", async () => {
    const cases: Array<{ label: string; payload: unknown }> = [
      { label: "NaN lat", payload: { taskId: TASK_ID, point: { lat: Number.NaN, lng: 77.5 } } },
      {
        label: "Infinity lng",
        payload: { taskId: TASK_ID, point: { lat: 12.9, lng: Number.POSITIVE_INFINITY } },
      },
      { label: "lat out of range", payload: { taskId: TASK_ID, point: { lat: 91, lng: 77.5 } } },
      { label: "lng out of range", payload: { taskId: TASK_ID, point: { lat: 12.9, lng: 181 } } },
      {
        label: "string coordinates",
        payload: { taskId: TASK_ID, point: { lat: "12.9", lng: "77.5" } },
      },
      { label: "missing point", payload: { taskId: TASK_ID } },
      { label: "null point", payload: { taskId: TASK_ID, point: null } },
      { label: "missing taskId", payload: { point: NEARBY } },
      { label: "not an object", payload: "gimme" },
      {
        label: "absurd speed",
        payload: { taskId: TASK_ID, point: NEARBY, speedMps: 5_000 },
      },
    ];

    for (const { label, payload } of cases) {
      const errored = nextError(helper);
      emitLocation(helper, payload);
      expect((await errored).code, label).toBe("INVALID_PAYLOAD");
    }

    await tick();
    // Neither the task position nor the availability geo index was touched by any of them.
    expect(await getTaskLocation(client, TASK_ID)).toBeNull();
    expect(await client.zscore(keys.helperGeo(), HELPER_ID)).toBeNull();
  });

  it("refuses a location in a non-tracking state (searching / matched / verifying / in-progress)", async () => {
    // TASK_STATES_WITH_LIVE_TRACKING is en-route + arrived only. `matched` and `verifying` are
    // deliberately excluded: a helper who has set off early advances to `en-route` (a legal,
    // helper-driven edge) rather than streaming precise position before identity is confirmed.
    for (const state of ["searching", "matched", "verifying", "in-progress"] as TaskState[]) {
      await setState(state);

      const errored = nextError(helper);
      emitLocation(helper, { taskId: TASK_ID, point: NEARBY });

      const err = await errored;
      expect(err.code, state).toBe("NOT_AUTHORIZED");
      expect(err.message, state).toContain(state);

      await tick();
      expect(await getTaskLocation(client, TASK_ID), state).toBeNull();
    }
  });

  it("accepts a location in `arrived` (still a live-tracking state)", async () => {
    await setState("arrived");
    emitLocation(helper, { taskId: TASK_ID, point: NEARBY });
    await tick();
    expect(await getTaskLocation(client, TASK_ID)).not.toBeNull();
  });

  it("refuses a location on a terminal task", async () => {
    await setState("cancelled");
    const errored = nextError(helper);
    emitLocation(helper, { taskId: TASK_ID, point: NEARBY });

    const err = await errored;
    expect(err.code).toBe("NOT_AUTHORIZED");
    expect(err.message).toContain("cancelled");
    await tick();
    expect(await getTaskLocation(client, TASK_ID)).toBeNull();
  });

  it("de-lists an in-task helper from the AVAILABILITY index (idle availability is a different concern)", async () => {
    // Pretend the helper published idle availability earlier (that is /presence's job, and the
    // only correct writer of this index). Once they are on a live tracked task they are busy,
    // so /tracking must remove them rather than — as the audited code did — refresh them and
    // keep them eligible for more offers.
    await upsertHelperGeo(client, HELPER_ID, NEARBY.lng, NEARBY.lat, clockNow);
    expect(await client.zscore(keys.helperGeoFresh(), HELPER_ID)).not.toBeNull();

    emitLocation(helper, { taskId: TASK_ID, point: NEARBY });
    await tick();

    expect(await client.zscore(keys.helperGeo(), HELPER_ID)).toBeNull();
    expect(await client.zscore(keys.helperGeoFresh(), HELPER_ID)).toBeNull();
    // ...while the TASK position is still recorded: the two concerns are separate stores.
    expect(await getTaskLocation(client, TASK_ID)).not.toBeNull();
  });

  it("rate-limits a location flood (audit C20) while leaving the 3–5s contract cadence room", async () => {
    // Capacity 12 at 1/s. A burst of 40 at a standstill clock must be cut off; the point is
    // that the limit exists at all, since this was the highest-frequency unbounded event.
    const errored = nextError(helper);
    for (let i = 0; i < 40; i += 1) {
      emitLocation(helper, { taskId: TASK_ID, point: NEARBY });
    }
    expect((await errored).code).toBe("RATE_LIMITED");

    // Let the REST of the flood's refusals land before asserting on the cadence below —
    // otherwise a leftover RATE_LIMITED from this burst gets mistaken for a fresh one.
    await tick(400);

    // A client on the real 3–5s cadence is never limited: advance the clock between fixes.
    for (let i = 0; i < 5; i += 1) {
      clockNow += 4_000;
      const rejected = nextError(helper, 250).then(
        (e) => e.code,
        () => null,
      );
      emitLocation(helper, { taskId: TASK_ID, point: NEARBY });
      expect(await rejected).toBeNull();
    }
  });

  it("refuses `join` for a non-participant, so the task room stays closed", async () => {
    const errored = nextError(stranger);
    (stranger as unknown as { emit: (e: string, p: unknown) => void }).emit("join", {
      taskId: TASK_ID,
    });
    expect((await errored).code).toBe("NOT_A_PARTICIPANT");
  });
});
