import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  NS,
  type ChatClientEvents,
  type ChatMessage,
  type ChatServerEvents,
  type SocketErrorPayload,
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
  type MessageRepository,
} from "../../domain/stores.js";
import { authMiddleware } from "../auth.js";
import { registerChat } from "../chat.js";

/**
 * ── AUDIT A3 PROOF (§2.5) ────────────────────────────────────────────────────
 * Before the fix, only `chat.join` checked participation. `send`, `typing` and `mark-read`
 * checked NOTHING, so any valid JWT could inject a persisted message into a stranger's
 * private task and flip read receipts on arbitrary global message ids. Room membership was
 * never a boundary either — `nsp.to(room)` accepts a room you never joined.
 *
 * This drives the REAL registerChat over a real socket.io server, a real ioredis against
 * localhost (per-test key prefix so it can't collide with a dev instance or a sibling test
 * file) and the real in-memory message repository, so the refusals are proven end-to-end and
 * the "nothing was persisted" assertion reads the actual store rather than a spy.
 *
 * Also covers: task-scoped mark-read, clientMsgId dedup, and B7 payload validation.
 */

type AppClient = ClientSocket<ChatServerEvents, ChatClientEvents>;
type SendAck = { ok: true; message: ChatMessage } | { ok: false; error: string };

const TASK_ID = "task-chat-1";
const OTHER_TASK_ID = "task-chat-2";
const REQUESTER_ID = "req-chat-1";
const HELPER_ID = "helper-chat-1";
/** User C: authenticated, but a participant of NEITHER task. The A3 attacker. */
const STRANGER_ID = "stranger-chat-9";

const ORIGIN = { lat: 12.9716, lng: 77.5946 };
const FIXED_NOW = 1_700_000_000_000;
const KEY_PREFIX = `test:chat-authz:${process.pid}:`;

/**
 * The injected clock. Everything in chat reads `deps.now()` (never Date.now()), so the tests
 * own time. It is NOT frozen: the chat token bucket refills from elapsed time, and a fully
 * frozen clock would make the whole suite share one 8-message burst — the later cases would
 * then fail with RATE_LIMITED, which proves nothing about authorization. Each test nudges the
 * clock forward by well over the refill window, so every case starts with a full bucket while
 * still being deterministic within itself.
 */
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
  const socket: AppClient = ioClient(`http://localhost:${port}${NS.chat}`, {
    transports: ["websocket"],
    auth: { token },
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

/** Emit `send` and resolve with its ack. */
function send(
  socket: AppClient,
  taskId: string,
  clientMsgId: string,
  body: string,
): Promise<SendAck> {
  return new Promise((resolve) => socket.emit("send", { taskId, clientMsgId, body }, resolve));
}

/** Send a deliberately malformed payload; the client-side typing is bypassed on purpose,
 *  because the whole point is that the SERVER must not trust the wire. */
function sendRawWithAck(socket: AppClient, payload: unknown): Promise<SendAck> {
  return new Promise((resolve) =>
    (
      socket as unknown as { emit: (e: string, p: unknown, ack: (r: SendAck) => void) => void }
    ).emit("send", payload, resolve),
  );
}

/** Resolve with the next `error` payload this socket receives, or reject on timeout — an
 *  absent refusal is itself the failure we are testing for (never a silent drop). */
function nextError(socket: AppClient, ms = 3_000): Promise<SocketErrorPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for an error event")), ms);
    socket.once("error", (payload) => {
      clearTimeout(timer);
      resolve(payload as SocketErrorPayload);
    });
  });
}

/**
 * Resolve with the first `error` payload matching `match`, ignoring any others.
 *
 * Needed wherever ONE burst can legitimately produce more than one kind of refusal, and the
 * order between them is a race rather than a property. The `mark-read` flood is exactly that:
 * the frames that pass the limiter are refused NOT_AUTHORIZED (their ids are absent) and the
 * frames that don't are refused RATE_LIMITED — both correct, and which lands first depends on
 * timing, because the first path emits only after 200 sequential repository reads while the
 * second emits after a single token check. `nextError` asserted on whichever won, so the test
 * failed roughly one run in five on a loaded machine while nothing was wrong.
 */
function errorMatching(
  socket: AppClient,
  match: (payload: SocketErrorPayload) => boolean,
  ms = 3_000,
): Promise<SocketErrorPayload> {
  return new Promise((resolve, reject) => {
    const onError = (raw: unknown): void => {
      const payload = raw as SocketErrorPayload;
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off("error", onError);
      reject(new Error("timed out waiting for a matching error event"));
    }, ms);
    socket.on("error", onError);
  });
}

const tick = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("/chat participant authorization (audit A3)", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let redisRaw: Redis;
  let requester: AppClient;
  let helper: AppClient;
  let stranger: AppClient;
  let messages: MessageRepository;
  const tasks = createInMemoryTaskRepo();

  beforeAll(async () => {
    // Real Redis with a per-run prefix: the dedup SET NX and the token buckets are the exact
    // behaviours under test, and ioredis-mock's Lua/SET-flag support is not worth fighting.
    redisRaw = new Redis(config.redisUrl, { keyPrefix: KEY_PREFIX });
    const client = redisRaw as unknown as RedisClient;
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    messages = createInMemoryMessageRepo();

    // The task under test, live (in-progress) so chat is open.
    await tasks.create({
      id: TASK_ID,
      requesterId: REQUESTER_ID,
      helperId: HELPER_ID,
      category: "errand",
      state: "in-progress",
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

    // A SECOND task the same requester belongs to. This is what makes the cross-task
    // mark-read case a real test: the caller is a legitimate participant of TASK_ID, and the
    // id they try to mark is a genuine message living in OTHER_TASK_ID.
    await tasks.create({
      id: OTHER_TASK_ID,
      requesterId: "req-chat-2",
      helperId: "helper-chat-2",
      category: "errand",
      state: "in-progress",
      origin: ORIGIN,
      title: "Someone else's task",
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
    await messages.append({
      id: "msg-other-task",
      taskId: OTHER_TASK_ID,
      senderId: "helper-chat-2",
      body: "private to the other task",
      createdAt: FIXED_NOW,
      status: "sent",
    });

    httpServer = createServer();
    io = new IOServer(httpServer);
    const deps: Deps = {
      io,
      redis,
      logger: silentLogger,
      config,
      tasks,
      messages,
      helpers: createInMemoryHelperProfileRepo(),
      sos: createInMemorySosRepo(),
      users: createInMemoryUserRepo(),
      services: createInMemoryServiceCatalog(),
      exceptions: createInMemoryExceptionRepo(),
      ...safetyDeps(),
      now: () => clockNow,
    };
    io.of(NS.chat).use(authMiddleware);
    registerChat(deps);

    await new Promise<void>((r) => httpServer.listen(0, r));
    const port = (httpServer.address() as AddressInfo).port;

    requester = await connect(port, REQUESTER_ID);
    helper = await connect(port, HELPER_ID);
    stranger = await connect(port, STRANGER_ID);
  });

  afterAll(async () => {
    for (const c of [requester, helper, stranger]) c?.disconnect();
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    // Clean up only OUR prefixed keys, so a shared dev Redis is left untouched.
    const keys = await redisRaw.keys(`${KEY_PREFIX}*`);
    if (keys.length > 0) {
      // `keys` comes back WITH the prefix, but del re-applies it — strip it first.
      await redisRaw.del(...keys.map((k) => k.slice(KEY_PREFIX.length)));
    }
    redisRaw.disconnect();
  });

  // Advance the injected clock a minute per test so every case starts with a refilled chat
  // bucket; see the note on `clockNow`.
  beforeEach(() => {
    clockNow += 60_000;
  });

  it("refuses `send` from a non-participant and persists nothing", async () => {
    const before = (await messages.list(TASK_ID)).length;

    const errored = nextError(stranger);
    const ack = await send(stranger, TASK_ID, "cmid-stranger-1", "let me in");

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error).toBe("not-a-participant");
    expect((await errored).code).toBe("NOT_A_PARTICIPANT");

    // The heart of A3: no row, and no broadcast, resulted from the attempt.
    await tick();
    const after = await messages.list(TASK_ID);
    expect(after).toHaveLength(before);
    expect(after.some((m) => m.senderId === STRANGER_ID)).toBe(false);
  });

  it("refuses `typing` from a non-participant and never relays into the task room", async () => {
    // The stranger cannot legitimately join, so prove the relay is authorization-gated (not
    // room-gated) by having a real participant listen for the forged indicator.
    await new Promise<void>((resolve) => {
      requester.emit("join", { taskId: TASK_ID });
      setTimeout(resolve, 80);
    });

    let leaked = false;
    const onTyping = (p: { userId: string }) => {
      if (p.userId === STRANGER_ID) leaked = true;
    };
    requester.on("helper-typing", onTyping);

    const errored = nextError(stranger);
    stranger.emit("typing", { taskId: TASK_ID, isTyping: true });

    expect((await errored).code).toBe("NOT_A_PARTICIPANT");
    await tick();
    requester.off("helper-typing", onTyping);
    expect(leaked).toBe(false);
  });

  it("refuses `mark-read` from a non-participant and leaves receipt status untouched", async () => {
    // Seed a real message in the task the stranger has no part in.
    const ack = await send(helper, TASK_ID, "cmid-helper-victim", "on my way");
    expect(ack.ok).toBe(true);
    const victimId = ack.ok ? ack.message.id : "";
    await tick();
    const statusBefore = (await messages.get(victimId))?.status;

    const errored = nextError(stranger);
    stranger.emit("mark-read", { taskId: TASK_ID, messageIds: [victimId] });

    expect((await errored).code).toBe("NOT_A_PARTICIPANT");
    await tick();
    // Still whatever the send flow left it at (delivered) — NOT read.
    expect((await messages.get(victimId))?.status).toBe(statusBefore);
    expect((await messages.get(victimId))?.status).not.toBe("read");
  });

  it("refuses a `mark-read` id that belongs to a different task", async () => {
    // The requester IS a legitimate participant of TASK_ID, so participation passes; the id
    // they supply lives in OTHER_TASK_ID and must still be refused.
    const errored = nextError(requester);
    requester.emit("mark-read", {
      taskId: TASK_ID,
      messageIds: ["msg-other-task"],
    });

    const err = await errored;
    expect(err.code).toBe("NOT_AUTHORIZED");
    expect(err.event).toBe("mark-read");

    await tick();
    const untouched = await messages.get("msg-other-task");
    expect(untouched?.status).toBe("sent");
  });

  it("dedups a repeated clientMsgId: one persisted message, the same id acked twice", async () => {
    const before = (await messages.list(TASK_ID)).length;
    const clientMsgId = "cmid-resend-after-reconnect";

    const first = await send(helper, TASK_ID, clientMsgId, "I'm outside");
    const second = await send(helper, TASK_ID, clientMsgId, "I'm outside");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      // The resend gets the ORIGINAL message back so the optimistic copy reconciles.
      expect(second.message.id).toBe(first.message.id);
      expect(second.message.createdAt).toBe(first.message.createdAt);
    }

    await tick();
    const added = (await messages.list(TASK_ID)).length - before;
    expect(added).toBe(1);
  });

  it("dedups two SIMULTANEOUS sends of one clientMsgId (SET NX, not GET-then-SET)", async () => {
    const before = (await messages.list(TASK_ID)).length;
    const clientMsgId = "cmid-racing-resend";

    // Fired together so both would observe "absent" under a GET-then-SET implementation.
    const [a, b] = await Promise.all([
      send(helper, TASK_ID, clientMsgId, "double tap"),
      send(helper, TASK_ID, clientMsgId, "double tap"),
    ]);

    const ids = [a, b].filter((r) => r.ok).map((r) => (r.ok ? r.message.id : ""));
    // Either both acks resolve to the one committed message, or the loser is told to retry —
    // what must NEVER happen is two distinct persisted rows.
    expect(new Set(ids).size).toBe(1);

    await tick();
    const added = (await messages.list(TASK_ID)).length - before;
    expect(added).toBe(1);
  });

  it("refuses malformed payloads with INVALID_PAYLOAD and persists nothing (audit B7)", async () => {
    const before = (await messages.list(TASK_ID)).length;

    const cases: Array<{ label: string; payload: unknown }> = [
      { label: "empty body", payload: { taskId: TASK_ID, clientMsgId: "c1", body: "" } },
      {
        label: "oversized body",
        payload: { taskId: TASK_ID, clientMsgId: "c2", body: "x".repeat(2_001) },
      },
      {
        label: "NaN body",
        payload: { taskId: TASK_ID, clientMsgId: "c3", body: Number.NaN },
      },
      { label: "missing clientMsgId", payload: { taskId: TASK_ID, body: "hi" } },
      { label: "missing taskId", payload: { clientMsgId: "c4", body: "hi" } },
      { label: "not an object", payload: "just a string" },
    ];

    for (const { label, payload } of cases) {
      const errored = nextError(helper);
      const ack = await sendRawWithAck(helper, payload);
      const err = await errored;
      expect(err.code, label).toBe("INVALID_PAYLOAD");
      expect(ack.ok, label).toBe(false);
      if (!ack.ok) expect(ack.error, label).toBe("invalid-payload");
    }

    // A whitespace-only body passes zod's min(1) but is not a message; the handler's own
    // trim check refuses it, still as INVALID_PAYLOAD.
    const blankErrored = nextError(helper);
    const blankAck = await sendRawWithAck(helper, {
      taskId: TASK_ID,
      clientMsgId: "c5",
      body: "    ",
    });
    expect((await blankErrored).code).toBe("INVALID_PAYLOAD");
    expect(blankAck.ok).toBe(false);

    await tick();
    expect((await messages.list(TASK_ID)).length).toBe(before);
  });

  it("still lets a real participant send, broadcast and mark the other side's message read", async () => {
    // The positive path, so the guards above are proven to refuse strangers rather than
    // everyone. Both parties are in the room.
    helper.emit("join", { taskId: TASK_ID });
    requester.emit("join", { taskId: TASK_ID });
    await tick();

    const received = new Promise<ChatMessage>((resolve) => requester.once("message", resolve));
    const ack = await send(helper, TASK_ID, "cmid-happy-path", "at your door");
    expect(ack.ok).toBe(true);
    const messageId = ack.ok ? ack.message.id : "";

    const fanned = await received;
    expect(fanned.body).toBe("at your door");
    expect(fanned.senderId).toBe(HELPER_ID);

    // The requester (the recipient) marks it read; a receipt-changed lands in the room.
    const receipt = new Promise<{ messageId: string; status: string }>((resolve) =>
      requester.once("receipt-changed", (p) => {
        if (p.status === "read") resolve(p);
      }),
    );
    requester.emit("mark-read", { taskId: TASK_ID, messageIds: [messageId] });
    expect((await receipt).messageId).toBe(messageId);
    expect((await messages.get(messageId))?.status).toBe("read");
  });

  it("ignores a caller marking their OWN message read (meaningless, and forgeable)", async () => {
    const ack = await send(helper, TASK_ID, "cmid-own-message", "own message");
    expect(ack.ok).toBe(true);
    const messageId = ack.ok ? ack.message.id : "";
    await tick();

    helper.emit("mark-read", { taskId: TASK_ID, messageIds: [messageId] });
    await tick();

    // Left at delivered: a sender must not be able to assert the other side read it.
    expect((await messages.get(messageId))?.status).toBe("delivered");
  });

  it("does not re-broadcast a receipt for an ALREADY-READ message (replay amplification)", async () => {
    // `setStatusForTask` is a blind UPDATE, so a replayed mark-read used to re-emit
    // `receipt-changed` into the room for a row that did not change — one frame replayed in a
    // loop became an amplified broadcast channel, and re-marking a page read on scroll is
    // ordinary client traffic rather than an edge case.
    const ack = await send(helper, TASK_ID, "cmid-replay", "read me once");
    expect(ack.ok).toBe(true);
    const messageId = ack.ok ? ack.message.id : "";
    await tick();

    // First mark-read is legitimate and MUST land (guards against "fixed by breaking receipts").
    const firstReceipt = new Promise<void>((resolve) =>
      helper.once("receipt-changed", (r) => {
        if (r.messageId === messageId && r.status === "read") resolve();
      }),
    );
    requester.emit("mark-read", { taskId: TASK_ID, messageIds: [messageId] });
    await firstReceipt;
    expect((await messages.get(messageId))?.status).toBe("read");

    // Now count only the REDUNDANT ones.
    let redundant = 0;
    const onReceipt = (r: { messageId: string; status: string }): void => {
      if (r.messageId === messageId && r.status === "read") redundant += 1;
    };
    helper.on("receipt-changed", onReceipt);
    for (let i = 0; i < 5; i += 1) {
      requester.emit("mark-read", { taskId: TASK_ID, messageIds: [messageId] });
    }
    await tick(500);
    helper.off("receipt-changed", onReceipt);
    expect(redundant).toBe(0);
  });

  it("rate-limits a `mark-read` flood (200 ids per frame is 200 repository reads)", async () => {
    // Unbounded before: one frame carries up to 200 ids and each costs a `messages.get`, so an
    // authorized participant could drive unlimited repository load by replaying one frame.
    const ids = Array.from({ length: 200 }, (_, i) => `probe-absent-${i}`);
    // Waits for the RATE_LIMITED refusal specifically. The same burst also produces
    // NOT_AUTHORIZED from the frames that got through the limiter — see `errorMatching`.
    const errored = errorMatching(requester, (e) => e.code === "RATE_LIMITED");
    for (let i = 0; i < 20; i += 1) {
      requester.emit("mark-read", { taskId: TASK_ID, messageIds: ids });
    }
    expect((await errored).event).toBe("mark-read");
    // Drain the rest of the burst's refusals so the next test starts clean.
    await tick(400);
  });

  it("refuses `send` on a terminal task (a cancelled conversation stays closed)", async () => {
    const closedId = "task-chat-closed";
    await tasks.create({
      id: closedId,
      requesterId: REQUESTER_ID,
      helperId: HELPER_ID,
      category: "errand",
      state: "cancelled",
      origin: ORIGIN,
      title: "Called off",
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

    const errored = nextError(helper);
    const ack = await send(helper, closedId, "cmid-after-close", "hello?");
    expect(ack.ok).toBe(false);
    expect((await errored).code).toBe("NOT_AUTHORIZED");
    expect(await messages.list(closedId)).toHaveLength(0);
  });
});
