import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryServiceCatalog } from "../../services/catalog.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { safetyDeps } from "../../test/safetyDeps.js";
// Typed by the ambient `declare module "ioredis-mock"` in src/types/ioredis-mock.d.ts — the
// package ships none of its own, and it is only ever used through the RedisClient cast below.
import RedisMock from "ioredis-mock";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  NS,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type PublicTask,
} from "@needy/shared";
import { config, type Config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import type { Deps } from "../../domain/deps.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import type { Logger } from "../../logger.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import { upsertHelperGeo } from "../../domain/location-store.js";
import { writePresence } from "../../domain/presence-store.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { makeUser } from "../../auth/types.js";
import { authMiddleware } from "../auth.js";
import { registerMatching } from "../matching.js";

/** The subset of the ioredis-mock surface this test touches directly (the GEO shim it
 *  installs, plus disconnect for teardown). Everything else flows through the RedisClient
 *  cast, so a loose index signature covers it. */
interface MockRedis {
  geoadd(key: string, lng: number, lat: number, member: string): Promise<number>;
  geosearch(...args: unknown[]): Promise<unknown[]>;
  geopos(key: string, member: string): Promise<unknown[]>;
  disconnect(): void;
  [command: string]: unknown;
}

/** §2.4 correctness proof: two helpers accept the SAME offer within milliseconds; the
 *  distributed lock + re-read guard in /matching must let exactly ONE win. This drives the
 *  real registerMatching over a real socket.io Server and a real Redis lock (ioredis-mock),
 *  so the double-accept race is exercised end-to-end, not mocked away. */

type ServerToClient = MatchingServerEvents;
type ClientToServer = MatchingClientEvents;
type AppClient = ClientSocket<ServerToClient, ClientToServer>;

/** The accept ack shape, mirrored from MatchingClientEvents["accept"]. */
type AcceptAck =
  | { won: true; task: PublicTask }
  | { won: false; reason: "already-taken" | "expired" };
type RequestHelpAck = { ok: true } | { ok: false; error: string };

const ORIGIN = { lat: 12.9716, lng: 77.5946 };
const FIXED_NOW = 1_700_000_000_000;
const TASK_ID = "task-race-1";
const REQUESTER_ID = "req-1";
const HELPER_A = "helper-a";
const HELPER_B = "helper-b";

/** ioredis-mock does not implement the GEO command family (geoadd/geosearch/geopos).
 *  Matching's candidate search relies on them, so we install a tiny in-memory GEO shim that
 *  returns the exact `[member, distString, [lngString, latString]]` tuple shape matching.ts
 *  parses. `multi().geoadd` and `geopos` are shimmed too — see the notes on each below. */
function installGeoShim(mock: MockRedis): void {
  const points = new Map<string, { lng: number; lat: number }>();

  const haversineMeters = (a: typeof ORIGIN, b: { lat: number; lng: number }) => {
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };

  mock.geoadd = async (
    _key: string,
    lng: number,
    lat: number,
    member: string,
  ): Promise<number> => {
    points.set(member, { lng: Number(lng), lat: Number(lat) });
    return 1;
  };

  // `upsertHelperGeo` now writes the point and its freshness score in ONE transaction (the
  // freshness index the lead added for A1/B9), so the shim has to cover the pipelined form
  // too — ioredis-mock's multi() has no `geoadd` at all and threw before this.
  const realMulti = mock.multi as (...a: unknown[]) => Record<string, unknown>;
  mock.multi = (...a: unknown[]): Record<string, unknown> => {
    const chain = realMulti.apply(mock, a);
    chain.geoadd = (_k: string, lng: number, lat: number, member: string) => {
      points.set(member, { lng: Number(lng), lat: Number(lat) });
      return chain; // chainable, like every other ioredis multi command
    };
    return chain;
  };

  // GEOPOS backs matching's ETA fallback to a helper's idle availability position (A6).
  // Returns the same `[[lng, lat]] | [null]` shape real Redis does.
  mock.geopos = async (_key: string, member: string): Promise<unknown[]> => {
    const p = points.get(member);
    return [p ? [String(p.lng), String(p.lat)] : null];
  };

  // Signature matches matching.ts: GEOSEARCH key FROMLONLAT lng lat BYRADIUS r m ASC WITHCOORD WITHDIST
  mock.geosearch = async (...args: unknown[]): Promise<unknown[]> => {
    const lng = Number(args[2]);
    const lat = Number(args[3]);
    const radius = Number(args[5]);
    const center = { lat, lng };
    const rows: [string, string, [string, string]][] = [];
    for (const [member, p] of points) {
      const dist = haversineMeters(center, p);
      if (dist <= radius) {
        rows.push([member, String(dist), [String(p.lng), String(p.lat)]]);
      }
    }
    rows.sort((a, b) => Number(a[1]) - Number(b[1]));
    return rows;
  };
}

/** A never-firing logger keeps the test output clean while still satisfying the Deps shape. */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ]);
}

function connectClient(port: number, userId: string, displayName: string): Promise<AppClient> {
  const token = signAccessToken({ sub: userId, role: "helper", displayName });
  const socket: AppClient = ioClient(`http://localhost:${port}${NS.matching}`, {
    transports: ["websocket"],
    auth: { token },
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (err) => reject(err));
  });
}

function emitAccept(socket: AppClient, taskId: string): Promise<AcceptAck> {
  return new Promise((resolve) => {
    socket.emit("accept", { taskId }, (result) => resolve(result));
  });
}

function emitRequestHelp(socket: AppClient, taskId: string): Promise<RequestHelpAck> {
  return new Promise((resolve) => {
    socket.emit("request-help", { taskId }, (result) => resolve(result));
  });
}

describe("/matching double-accept race (§2.4)", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let mock: MockRedis;
  let requester: AppClient;
  let helperA: AppClient;
  let helperB: AppClient;
  const offerReceived: Record<string, Deferred<void>> = {
    [HELPER_A]: deferred<void>(),
    [HELPER_B]: deferred<void>(),
  };
  const offerClosed: Record<string, Deferred<{ taskId: string; reason: string }>> = {
    [HELPER_A]: deferred(),
    [HELPER_B]: deferred(),
  };

  const tasks = createInMemoryTaskRepo();
  /** Matching now resolves a CANDIDATE's role + KYC from the durable user record rather than
   *  assuming it (audit B11), so both helpers need a verified row here or they are — correctly
   *  — never offered the task and the race has nothing to race. */
  const users = createInMemoryUserRepo();

  beforeAll(async () => {
    // ── Redis (ioredis-mock) with the GEO shim the matching search needs. ──
    mock = new RedisMock() as MockRedis;
    installGeoShim(mock);
    const client = mock as unknown as RedisClient;
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    // ── In-memory data layer + seed state. ──
    const helpers = createInMemoryHelperProfileRepo({
      [HELPER_A]: {
        id: HELPER_A,
        displayName: "Helper A",
        photoUrl: "",
        rating: 4.8,
        helpedCount: 12,
      },
      [HELPER_B]: {
        id: HELPER_B,
        displayName: "Helper B",
        photoUrl: "",
        rating: 4.9,
        helpedCount: 20,
      },
    });

    await tasks.create({
      id: TASK_ID,
      requesterId: REQUESTER_ID,
      helperId: null,
      category: "errand",
      state: "searching",
      origin: ORIGIN,
      title: "Pick up medicine",
      description: "test", price: 100, serviceCode: null, scheduledFor: null, serviceBrief: null, handoffOtpHash: null, handoffOtpExpiresAt: null, handoffVerifiedAt: null, createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });

    // The requester needs a durable record too: matching evaluates the eligibility matrix
    // against BOTH parties, and it fails closed — an unknown requester matches nobody.
    await users.create(
      makeUser({
        id: REQUESTER_ID,
        phone: "+919111100001",
        displayName: "Requester",
        dateOfBirth: "1985-06-15",
        gender: "male",
        onboardingStatus: "approved",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }),
    );

    // Both helpers are online-available, verified, and geographically nearby, so both get the
    // offer. `upsertHelperGeo` takes the publish timestamp now (A1/B9 freshness index).
    await upsertHelperGeo(client, HELPER_A, 77.595, 12.972, FIXED_NOW);
    await upsertHelperGeo(client, HELPER_B, 77.594, 12.9712, FIXED_NOW);
    for (const helperId of [HELPER_A, HELPER_B]) {
      await writePresence(client, {
        userId: helperId,
        state: "online-available",
        activity: "idle",
        lastActiveAt: FIXED_NOW,
      });
      await users.create(
        makeUser({
        dateOfBirth: "1985-06-15",
        gender: "male",
          id: helperId,
          phone: `+9199990${helperId.slice(-1)}`,
          displayName: helperId,
          role: "helper",
          kycStatus: "verified",
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      );
    }

    // ── Minimal io server that wires the real registrar (no index.ts bootstrap). ──
    httpServer = createServer();
    io = new IOServer(httpServer);
    const deps: Deps = {
      io,
      redis,
      logger: silentLogger,
      config: { ...config, match: { ...config.match, offerWindowMs: 60_000 } } as Config,
      tasks,
      messages: createInMemoryMessageRepo(),
      helpers,
      sos: createInMemorySosRepo(),
      users,
      services: createInMemoryServiceCatalog(),
      exceptions: createInMemoryExceptionRepo(),
      ...safetyDeps(),
      now: () => FIXED_NOW,
    };
    io.of(NS.matching).use(authMiddleware);
    registerMatching(deps);

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    requester = await connectClient(port, REQUESTER_ID, "Requester");
    helperA = await connectClient(port, HELPER_A, "Helper A");
    helperB = await connectClient(port, HELPER_B, "Helper B");

    helperA.on("offer", () => offerReceived[HELPER_A].resolve());
    helperB.on("offer", () => offerReceived[HELPER_B].resolve());
    helperA.on("offer-closed", (p) => offerClosed[HELPER_A].resolve(p));
    helperB.on("offer-closed", (p) => offerClosed[HELPER_B].resolve(p));
  });

  afterAll(async () => {
    for (const c of [requester, helperA, helperB]) c?.disconnect();
    await io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    mock.disconnect();
  });

  it("lets exactly one of two simultaneous accepts win, and closes the offer for the loser", async () => {
    const reqAck = await emitRequestHelp(requester, TASK_ID);
    expect(reqAck).toEqual({ ok: true });

    // Wait until BOTH helpers actually hold the offer, so their accepts truly race.
    await withTimeout(
      Promise.all([offerReceived[HELPER_A].promise, offerReceived[HELPER_B].promise]),
      3_000,
      "both helpers to receive the offer",
    );

    // Fire both accepts as close to simultaneously as possible and settle their acks together.
    const [ackA, ackB] = await withTimeout(
      Promise.all([emitAccept(helperA, TASK_ID), emitAccept(helperB, TASK_ID)]),
      3_000,
      "both accept acks",
    );

    const results = [
      { helperId: HELPER_A, ack: ackA },
      { helperId: HELPER_B, ack: ackB },
    ];

    // ── Exactly one winner, exactly one loser. ──
    const winners = results.filter((r) => r.ack.won);
    const losers = results.filter((r) => !r.ack.won);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winner = winners[0]!;
    const loser = losers[0]!;

    // Winner's ack carries the matched task assigned to them.
    if (winner.ack.won) {
      expect(winner.ack.task.helperId).toBe(winner.helperId);
      expect(winner.ack.task.state).toBe("matched");
    }

    // Loser lost the race with the exact reason the guard reports.
    if (!loser.ack.won) {
      expect(loser.ack.reason).toBe("already-taken");
    }

    // ── The persisted task reflects the winner, and only the winner. ──
    const finalTask = await tasks.get(TASK_ID);
    expect(finalTask?.state).toBe("matched");
    expect(finalTask?.helperId).toBe(winner.helperId);

    // ── The loser receives an `offer-closed` / already-taken event. ──
    const closed = await withTimeout(
      offerClosed[loser.helperId].promise,
      3_000,
      "offer-closed for the losing helper",
    );
    expect(closed).toEqual({ taskId: TASK_ID, reason: "already-taken" });
  });
});
