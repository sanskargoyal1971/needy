import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { NS, type ChatMessage } from "@needy/shared";
import { config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import type { Deps } from "../../domain/deps.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
  type MessageRepository,
} from "../../domain/stores.js";
import { authMiddleware } from "../auth.js";
import { registerChat } from "../chat.js";

/** ── Acknowledgement callbacks are optional on the wire ────────────────────
 *  `ChatClientEvents.send` types `ack` as required, but a type only binds code that imports it.
 *  Anything can put a frame on a socket: an older client, a different SDK, or someone poking at
 *  the namespace by hand. socket.io then invokes the handler with `ack === undefined`.
 *
 *  Why this is worth its own test rather than being a shrug: in `send` the ack fires AFTER the
 *  message is appended and BEFORE `nsp.to(room).emit("message", …)`. A throw there commits the
 *  message to storage and delivers it to nobody — no error to the sender, nothing to the
 *  recipient, and a row in Postgres that the conversation will never show. Silent write-then-drop
 *  is the worst failure mode a chat has, and reaching it needs no privileges at all.
 *
 *  Real Redis (dedup uses SET NX with a real PX), per-run keyPrefix so a shared dev instance is
 *  untouched.
 */

const PREFIX = `test:ack-optional:${process.pid}:`;
const TASK = "task-ack";

/** Raw emit that bypasses the typed client, which would otherwise insist on the callback —
 *  the whole point is to send the frame a well-behaved client cannot produce. */
function emitRaw(sock: ClientSocket, event: string, payload: unknown): void {
  (sock as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
}

describe("socket acks are optional on the wire", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let redisRaw: Redis;
  let messages: MessageRepository;
  let sock: ClientSocket;
  const rejections: unknown[] = [];

  beforeAll(async () => {
    // An unhandled rejection is the *symptom* of the bug — socket.io swallows the throw inside
    // the async handler, so without watching for this the failure is invisible to the test.
    process.on("unhandledRejection", (r) => rejections.push(r));

    redisRaw = new Redis(config.redisUrl, { keyPrefix: PREFIX });
    const client = redisRaw as unknown as RedisClient;
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    const tasks = createInMemoryTaskRepo();
    messages = createInMemoryMessageRepo();
    await tasks.create({
      id: TASK,
      requesterId: "requester-1",
      helperId: "helper-1",
      category: "errand",
      state: "in-progress",
      origin: { lat: 12.9716, lng: 77.5946 },
      title: "groceries",
      description: "test", price: 100, createdAt: 1,
      updatedAt: 1,
    });

    httpServer = createServer();
    io = new IOServer(httpServer);
    const deps: Deps = {
      io,
      redis,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      config,
      tasks,
      messages,
      helpers: createInMemoryHelperProfileRepo(),
      sos: createInMemorySosRepo(),
      users: createInMemoryUserRepo(),
      now: () => Date.now(),
    };
    io.of(NS.chat).use(authMiddleware);
    registerChat(deps);

    await new Promise<void>((r) => httpServer.listen(0, r));
    const { port } = httpServer.address() as AddressInfo;
    const token = signAccessToken({
      sub: "helper-1",
      role: "both",
      displayName: "Asha",
      kyc: "verified",
    });
    sock = ioClient(`http://localhost:${port}${NS.chat}`, {
      transports: ["websocket"],
      auth: { token },
      forceNew: true,
    });
    await new Promise<void>((res, rej) => {
      sock.on("connect", () => res());
      sock.on("connect_error", rej);
    });
    emitRaw(sock, "join", { taskId: TASK });
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    sock?.disconnect();
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    const found = await redisRaw.keys(`${PREFIX}*`);
    if (found.length) await redisRaw.del(...found.map((k) => k.slice(PREFIX.length)));
    redisRaw.disconnect();
  });

  it("still persists AND broadcasts a valid `send` that arrives with no ack callback", async () => {
    const seen: ChatMessage[] = [];
    sock.on("message" as never, ((m: ChatMessage) => seen.push(m)) as never);

    emitRaw(sock, "send", { taskId: TASK, clientMsgId: "no-ack-1", body: "are you nearby?" });
    await new Promise((r) => setTimeout(r, 400));

    const stored = await messages.list(TASK);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body).toBe("are you nearby?");

    // The assertion that actually pins the bug: before the fix the message was stored but the
    // broadcast never ran, so `stored` was length 1 and `seen` was empty.
    expect(seen.map((m) => m.body)).toEqual(["are you nearby?"]);
  });

  it("promotes the ack-less message to delivered, so receipts don't stall either", async () => {
    // The delivered promotion sits after the broadcast, further down the same handler — it is
    // only reached if nothing threw on the way.
    const stored = await messages.list(TASK);
    expect(stored[0]?.status).toBe("delivered");
  });

  it("raises no unhandled rejection for an ack-less send", () => {
    expect(rejections.map(String)).toEqual([]);
  });

  it("refuses an ack-less INVALID payload via the error event instead of throwing", async () => {
    const errors: Array<{ code: string }> = [];
    sock.on("error" as never, ((e: { code: string }) => errors.push(e)) as never);

    emitRaw(sock, "send", { taskId: TASK }); // no body, no clientMsgId, no ack
    await new Promise((r) => setTimeout(r, 250));

    expect(errors.map((e) => e.code)).toContain("INVALID_PAYLOAD");
    expect(rejections.map(String)).toEqual([]);
    // And nothing extra was written.
    expect(await messages.list(TASK)).toHaveLength(1);
  });

  it("still delivers the ack when a client DOES supply one", async () => {
    // Guard against "fixed by making the ack path dead": the normal contract must be intact.
    const result = await new Promise<{ ok: boolean }>((resolve) => {
      sock.emit(
        "send" as never,
        { taskId: TASK, clientMsgId: "with-ack-1", body: "on my way" } as never,
        resolve as never,
      );
    });
    expect(result.ok).toBe(true);
    expect(await messages.list(TASK)).toHaveLength(2);
  });
});
