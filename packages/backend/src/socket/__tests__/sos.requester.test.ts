import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  NS,
  type SosAlert,
  type SosClientEvents,
  type SosServerEvents,
  type SocketErrorPayload,
} from "@needy/shared";
import { config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import type { Deps } from "../../domain/deps.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import type { Logger } from "../../logger.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { createInMemorySosRepo, type SosRepository } from "../../domain/sosStore.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import { authMiddleware } from "../auth.js";
import { registerSos, SOS_OPERATOR_ROOM } from "../sos.js";

/**
 * ── REQUESTER SOS PROOF ──────────────────────────────────────────────────────
 *
 * The frontend audit found the requester's SOS button was local `useState` driving a red
 * escalation animation with NO network call behind it — `NeedyDriver` had no `raiseSos` at all.
 * Pressing it told a frightened person help was coming while emitting nothing to any server, and
 * a reload erased the "alarm" entirely. The helper side had been fixed; the requester side, which
 * is the side used by the elderly and vulnerable users the product is built for, had not.
 *
 * A unit test on the button component would NOT have closed that gap: the old button would have
 * passed one, because it did render an armed state. What was missing was the wire. So this test
 * deliberately drives the whole path — a real socket.io server, the real `registerSos` handler,
 * a real ioredis (the rate-limit token bucket is real behaviour), the real durable repository —
 * and asserts on the STORE and on what the OTHER parties actually receive, never on a spy.
 *
 * What it pins down:
 *   1. A requester's raise creates a durable alert that is readable back out of the repository.
 *   2. The helper is told, and so is the operator room (the trust & safety surface).
 *   3. The ack carries the persisted alert, which is the only thing that licenses the UI to say
 *      "help has been notified".
 *   4. A non-participant cannot raise an alarm on someone else's task, and nothing is persisted.
 *   5. A helper cannot silence the requester's alarm — the abuse case that matters most.
 */

type SosSocketClient = ClientSocket<SosServerEvents, SosClientEvents>;
type RaiseAck = { ok: true; alert: SosAlert } | { ok: false; error: string };
type CancelAck = { ok: true; alert: SosAlert } | { ok: false; error: string };

const TASK_ID = "task-sos-1";
const REQUESTER_ID = "req-sos-1";
const HELPER_ID = "helper-sos-1";
/** Authenticated, but a participant of nothing. */
const STRANGER_ID = "stranger-sos-9";

const ORIGIN = { lat: 12.9716, lng: 77.5946 };
const FIXED_NOW = 1_700_000_000_000;
const KEY_PREFIX = `test:sos-requester:${process.pid}:`;

/** Injected clock. Nudged forward per test so each case starts with a refilled SOS bucket —
 *  a frozen clock would make later cases fail with RATE_LIMITED, proving nothing. */
let clockNow = FIXED_NOW;

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function connect(port: number, userId: string): Promise<SosSocketClient> {
  const token = signAccessToken({
    sub: userId,
    role: "both",
    displayName: userId,
    kyc: "verified",
  });
  const socket: SosSocketClient = ioClient(`http://localhost:${port}${NS.sos}`, {
    transports: ["websocket"],
    auth: { token },
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

function raise(
  socket: SosSocketClient,
  taskId: string,
  kind: SosAlert["kind"],
  extras: { at?: { lat: number; lng: number }; note?: string } = {},
): Promise<RaiseAck> {
  return new Promise((resolve) =>
    socket.emit("raise", { taskId, kind, ...extras }, resolve),
  );
}

function cancel(socket: SosSocketClient, alertId: string): Promise<CancelAck> {
  return new Promise((resolve) => socket.emit("cancel", { alertId }, resolve));
}

/** Resolve with the next event of this name, or reject on timeout — silence is itself a
 *  failure when the whole point is that the other party must be told. */
function nextEvent<K extends "sos-raised" | "sos-updated">(
  socket: SosSocketClient,
  event: K,
  ms = 3_000,
): Promise<SosAlert> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${event}`)),
      ms,
    );
    (socket as any).once(event, (alert: any) => {
      clearTimeout(timer);
      resolve(alert as SosAlert);
    });
  });
}

function nextError(socket: SosSocketClient, ms = 3_000): Promise<SocketErrorPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for an error event")),
      ms,
    );
    socket.once("error", (payload) => {
      clearTimeout(timer);
      resolve(payload as SocketErrorPayload);
    });
  });
}

const tick = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("requester SOS reaches a real server (frontend audit: the button called nobody)", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let redisRaw: Redis;
  let requester: SosSocketClient;
  let helper: SosSocketClient;
  let stranger: SosSocketClient;
  /** Stands in for the trust & safety console: a socket joined to the operator room. */
  let operator: SosSocketClient;
  let sos: SosRepository;
  const tasks = createInMemoryTaskRepo();

  beforeAll(async () => {
    redisRaw = new Redis(config.redisUrl, { keyPrefix: KEY_PREFIX });
    const client = redisRaw as unknown as RedisClient;
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    sos = createInMemorySosRepo();

    await tasks.create({
      id: TASK_ID,
      requesterId: REQUESTER_ID,
      helperId: HELPER_ID,
      category: "errand",
      state: "in-progress",
      origin: ORIGIN,
      title: "Pick up medicine",
      description: "test", price: 100, createdAt: FIXED_NOW,
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
      sos,
      users: createInMemoryUserRepo(),
      now: () => clockNow,
    };
    io.of(NS.sos).use(authMiddleware);
    registerSos(deps);

    await new Promise<void>((r) => httpServer.listen(0, r));
    const port = (httpServer.address() as AddressInfo).port;

    requester = await connect(port, REQUESTER_ID);
    helper = await connect(port, HELPER_ID);
    stranger = await connect(port, STRANGER_ID);
    operator = await connect(port, "operator-1");

    // Put the operator in the room the handler fans out to. In production an admin console
    // joins this on authenticating as staff; here we do it server-side so the test exercises
    // the same broadcast path rather than a special case.
    for (const s of await io.of(NS.sos).fetchSockets()) {
      if ((s.data as { user: { sub: string } }).user.sub === "operator-1") {
        await s.join(SOS_OPERATOR_ROOM);
      }
    }
  });

  afterAll(async () => {
    for (const c of [requester, helper, stranger, operator]) c?.disconnect();
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    const keys = await redisRaw.keys(`${KEY_PREFIX}*`);
    if (keys.length > 0) {
      await redisRaw.del(...keys.map((k) => k.slice(KEY_PREFIX.length)));
    }
    redisRaw.disconnect();
  });

  beforeEach(() => {
    clockNow += 60_000;
  });

  it("persists a durable alert and tells the helper AND the operator room", async () => {
    const helperSaw = nextEvent(helper, "sos-raised");
    const operatorSaw = nextEvent(operator, "sos-raised");

    const ack = await raise(requester, TASK_ID, "panic", {
      at: ORIGIN,
      note: "I don't feel safe",
    });

    // 1. The ack carries a persisted alert. This is the ONLY thing that may make the UI claim
    //    help has been notified — the old button claimed it with nothing behind it at all.
    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error(`raise refused: ${ack.error}`);
    expect(ack.alert.raisedBy).toBe(REQUESTER_ID);
    expect(ack.alert.taskId).toBe(TASK_ID);
    expect(ack.alert.status).toBe("raised");

    // 2. It is genuinely in the store — read back out, not asserted through a spy. This is the
    //    assertion the old implementation could never have satisfied: there was no row.
    const stored = await sos.get(ack.alert.id);
    expect(stored).not.toBeNull();
    expect(stored?.raisedBy).toBe(REQUESTER_ID);
    expect(stored?.kind).toBe("panic");
    expect(stored?.note).toBe("I don't feel safe");
    // The raiser's OWN position, not the helper's last tracked point.
    expect(stored?.at).toEqual(ORIGIN);

    // 3. Both the other participant and the operator surface actually received it.
    expect((await helperSaw).id).toBe(ack.alert.id);
    expect((await operatorSaw).id).toBe(ack.alert.id);
  });

  it("refuses a raise from a non-participant and persists nothing", async () => {
    const before = await sos.activeForTask(TASK_ID);

    const errored = nextError(stranger);
    const ack = await raise(stranger, TASK_ID, "panic");

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error).toBe("not-a-participant");
    expect((await errored).code).toBe("NOT_A_PARTICIPANT");

    await tick();
    const after = await sos.activeForTask(TASK_ID);
    expect(after).toHaveLength(before.length);
    expect(after.some((a) => a.raisedBy === STRANGER_ID)).toBe(false);
  });

  it("lets the requester stand down their OWN alert, and tells both parties", async () => {
    const ack = await raise(requester, TASK_ID, "unsafe");
    if (!ack.ok) throw new Error(`raise refused: ${ack.error}`);

    const helperSaw = nextEvent(helper, "sos-updated");
    const cancelled = await cancel(requester, ack.alert.id);

    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error("cancel refused");
    expect(cancelled.alert.status).toBe("cancelled");
    expect((await helperSaw).status).toBe("cancelled");

    // The record survives the stand-down — a false alarm is still an auditable event.
    const stored = await sos.get(ack.alert.id);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("cancelled");
  });

  it("does NOT let the helper silence the requester's alarm about them", async () => {
    const ack = await raise(requester, TASK_ID, "unsafe");
    if (!ack.ok) throw new Error(`raise refused: ${ack.error}`);

    const errored = nextError(helper);
    const attempt = await cancel(helper, ack.alert.id);

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toBe("not-authorized");
    expect((await errored).code).toBe("NOT_AUTHORIZED");

    // Still live. This is the abuse case that matters most: the person the alarm is ABOUT
    // must not be able to make it go away.
    const stored = await sos.get(ack.alert.id);
    expect(stored?.status).toBe("raised");
  });
});
