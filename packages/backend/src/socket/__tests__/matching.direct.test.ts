import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  BOOKING_CONFIRM_BY_MS,
  BOOKING_DISPATCH_LEAD_MS,
  DIRECT_OFFER_WINDOW_MS,
  makeTask,
  NS,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type MatchOffer,
  type PublicTask,
  type Task,
} from "@needy/shared";
import { config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { makeUser, type User } from "../../auth/types.js";
import type { Deps } from "../../domain/deps.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { keys } from "../../domain/keys.js";
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
import { dispatchDueDirectOffers, registerMatching } from "../matching.js";

/**
 * Direct offers: a booking for a named helper, or "ask the same person again".
 *
 * These tasks sat in `searching` with a helper attached and nothing ever moved them — the
 * open search refuses them (correctly: broadcasting would hand the booking to a stranger) and
 * there was no scheduler. Now the dispatcher offers them to their one helper when due, the
 * helper's answer settles them, and silence or a "no" tells the requester instead of leaving
 * them waiting.
 */

type AppClient = ClientSocket<MatchingServerEvents, MatchingClientEvents>;
type AcceptAck = { won: true; task: PublicTask } | { won: false; reason: string };

const REQUESTER = "req-direct";
const NAMED = "helper-named";
const OTHER = "helper-other";
const T0 = 1_800_000_000_000;
const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("/matching direct offers", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let port: number;
  let client: RedisClient;
  let now = T0;
  let deps: Deps;
  const tasks = createInMemoryTaskRepo();
  const users = createInMemoryUserRepo();
  const sockets: AppClient[] = [];
  const offers: Record<string, MatchOffer[]> = { [NAMED]: [], [OTHER]: [] };
  const updates: PublicTask[] = [];
  let named: AppClient;
  let other: AppClient;

  const person = (id: string, role: User["role"], over: Partial<User> = {}) =>
    users.create(
      makeUser({
        id,
        phone: `+91999${id.length}0${id.slice(-3).replace(/\D/g, "1")}12`,
        displayName: id,
        role,
        kycStatus: "verified",
        dateOfBirth: "1960-01-01",
        gender: "female",
        ...over,
      }),
    );

  function connect(userId: string): Promise<AppClient> {
    const token = signAccessToken({ sub: userId, role: "helper", displayName: userId });
    const s: AppClient = ioClient(`http://localhost:${port}${NS.matching}`, {
      transports: ["websocket"],
      auth: { token },
      forceNew: true,
    });
    sockets.push(s);
    return new Promise((resolve, reject) => {
      s.on("connect", () => resolve(s));
      s.on("connect_error", reject);
    });
  }

  const seed = (id: string, over: Partial<Task> = {}) =>
    tasks.create(
      makeTask({
        id,
        requesterId: REQUESTER,
        helperId: NAMED,
        category: "companionship",
        state: "searching",
        origin: { lat: 17.4632, lng: 78.3673 },
        title: "Evening walk",
        createdAt: now,
        updatedAt: now,
        ...over,
      }),
    );

  const accept = (s: AppClient, taskId: string) =>
    new Promise<AcceptAck>((resolve) => s.emit("accept", { taskId }, resolve));

  /** Socket delivery is asynchronous; wait until `check` passes or give up. */
  async function until(check: () => boolean, ms = 3_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) return;
      await sleep(20);
    }
  }

  beforeAll(async () => {
    client = new RedisMock() as unknown as RedisClient;
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;
    await person(REQUESTER, "requester");
    await person(NAMED, "helper");
    await person(OTHER, "helper");

    httpServer = createServer();
    io = new IOServer(httpServer);
    deps = {
      io,
      redis,
      logger: silentLogger,
      config,
      tasks,
      messages: createInMemoryMessageRepo(),
      helpers: createInMemoryHelperProfileRepo(),
      sos: createInMemorySosRepo(),
      users,
      services: createInMemoryServiceCatalog(),
      exceptions: createInMemoryExceptionRepo(),
      ...safetyDeps(),
      now: () => now,
    };
    io.of(NS.matching).use(authMiddleware);
    registerMatching(deps);
    await new Promise<void>((r) => httpServer.listen(0, r));
    port = (httpServer.address() as AddressInfo).port;

    named = await connect(NAMED);
    other = await connect(OTHER);
    const requester = await connect(REQUESTER);
    named.on("offer", (o) => offers[NAMED]!.push(o));
    other.on("offer", (o) => offers[OTHER]!.push(o));
    requester.on("task-updated", ({ task }) => updates.push(task));
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  beforeEach(() => {
    offers[NAMED]!.length = 0;
    offers[OTHER]!.length = 0;
    updates.length = 0;
  });

  const nsp = () => io.of(NS.matching) as never;

  it("offers an unscheduled ask to the named helper alone, and only once while it is open", async () => {
    await seed("t-now");
    await dispatchDueDirectOffers(deps, nsp());
    await dispatchDueDirectOffers(deps, nsp());
    await until(() => offers[NAMED]!.length > 0);

    expect(offers[NAMED]).toHaveLength(1);
    expect(offers[OTHER]).toHaveLength(0);
    const offer = offers[NAMED]![0]!;
    expect(offer).toMatchObject({ taskId: "t-now", direct: true, scheduledFor: null });
    expect(offer.expiresAt).toBe(now + DIRECT_OFFER_WINDOW_MS);
    // Coarse, as for every offer: the door is only sent to an accepted helper.
    expect(offer.origin).not.toEqual({ lat: 17.4632, lng: 78.3673 });
  });

  it("lets the named helper accept it — and nobody else", async () => {
    const stolen = await accept(other, "t-now");
    expect(stolen.won).toBe(false);

    const ack = await accept(named, "t-now");
    expect(ack.won).toBe(true);
    const task = await tasks.get("t-now");
    expect(task).toMatchObject({ state: "matched", helperId: NAMED });
    expect(await client.zscore(keys.offerExpiryQueue(), "t-now")).toBeNull();
  });

  it("ends at once when the helper says no, and tells the requester", async () => {
    await seed("t-decline");
    await dispatchDueDirectOffers(deps, nsp());
    await until(() => offers[NAMED]!.some((o) => o.taskId === "t-decline"));

    named.emit("decline", { taskId: "t-decline" });
    await until(() => updates.some((t) => t.id === "t-decline"));

    expect((await tasks.get("t-decline"))?.state).toBe("unmatched");
    expect(updates.find((t) => t.id === "t-decline")?.state).toBe("unmatched");
  });

  it("ends when nobody answers in time, instead of widening to strangers", async () => {
    await seed("t-silent");
    await dispatchDueDirectOffers(deps, nsp());
    await until(() => offers[NAMED]!.some((o) => o.taskId === "t-silent"));

    now += DIRECT_OFFER_WINDOW_MS + 1;
    // The durable expiry sweep runs every second.
    await until(() => updates.some((t) => t.id === "t-silent"), 4_000);

    expect((await tasks.get("t-silent"))?.state).toBe("unmatched");
    expect(offers[OTHER]).toHaveLength(0);
  });

  it("holds a booking until its dispatch lead, then asks for confirmation ahead of the start", async () => {
    const startsAt = now + BOOKING_DISPATCH_LEAD_MS + 60 * 60 * 1000;
    await seed("t-booked", { scheduledFor: startsAt });

    await dispatchDueDirectOffers(deps, nsp());
    await sleep(100);
    expect(offers[NAMED]!.some((o) => o.taskId === "t-booked")).toBe(false);

    now = startsAt - BOOKING_DISPATCH_LEAD_MS + 1;
    await dispatchDueDirectOffers(deps, nsp());
    await until(() => offers[NAMED]!.some((o) => o.taskId === "t-booked"));

    const offer = offers[NAMED]!.find((o) => o.taskId === "t-booked")!;
    expect(offer.scheduledFor).toBe(startsAt);
    expect(offer.expiresAt).toBe(startsAt - BOOKING_CONFIRM_BY_MS);
  });

  it("re-checks the pairing at dispatch: a helper blocked since booking is never offered it", async () => {
    await users.update(OTHER, { blockedAt: now });
    await seed("t-blocked", { helperId: OTHER });

    await dispatchDueDirectOffers(deps, nsp());
    await until(() => updates.some((t) => t.id === "t-blocked"));

    expect(offers[OTHER]!.some((o) => o.taskId === "t-blocked")).toBe(false);
    expect((await tasks.get("t-blocked"))?.state).toBe("unmatched");
  });

  it("never offers a booking whose start has already passed", async () => {
    await seed("t-missed", { scheduledFor: now - 60_000 });

    await dispatchDueDirectOffers(deps, nsp());
    await until(() => updates.some((t) => t.id === "t-missed"));

    expect(offers[NAMED]!.some((o) => o.taskId === "t-missed")).toBe(false);
    expect((await tasks.get("t-missed"))?.state).toBe("unmatched");
  });
});
