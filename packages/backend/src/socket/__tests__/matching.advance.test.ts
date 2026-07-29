import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- untyped module
import RedisMock from "ioredis-mock";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  NS,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type Task,
  type TaskState,
} from "@needy/shared";
import { config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import type { Deps } from "../../domain/deps.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import type { Logger } from "../../logger.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import { authMiddleware } from "../auth.js";
import { registerMatching } from "../matching.js";

/**
 * Guards the `advance-task` lifecycle action: only legal TASK_TRANSITIONS succeed, only
 * participants may drive them, `matched` can never be set by a free advance, and every
 * accepted transition broadcasts `task-updated` to the party.
 */

type AppClient = ClientSocket<MatchingServerEvents, MatchingClientEvents>;
type AdvanceAck = { ok: true; task: Task } | { ok: false; error: string };

const TASK_ID = "task-advance-1";
const REQUESTER_ID = "req-1";
const HELPER_ID = "helper-1";
const STRANGER_ID = "stranger-9";

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function connect(port: number, userId: string): Promise<AppClient> {
  const token = signAccessToken({ sub: userId, role: "requester", displayName: userId });
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

function advance(socket: AppClient, to: TaskState): Promise<AdvanceAck> {
  return new Promise((resolve) => socket.emit("advance-task", { taskId: TASK_ID, to }, resolve));
}

describe("/matching advance-task lifecycle guard", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let mock: { disconnect(): void };
  let requester: AppClient;
  let stranger: AppClient;
  const tasks = createInMemoryTaskRepo();

  beforeAll(async () => {
    mock = new RedisMock();
    const client = mock as unknown as RedisClient;
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    // Seed an already-matched task (helper assigned), the starting point for advancement.
    await tasks.create({
      id: TASK_ID,
      requesterId: REQUESTER_ID,
      helperId: HELPER_ID,
      category: "errand",
      state: "matched",
      origin: { lat: 12.9716, lng: 77.5946 },
      title: "Pick up medicine",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
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
      now: () => 1_700_000_050_000,
    };
    io.of(NS.matching).use(authMiddleware);
    registerMatching(deps);

    await new Promise<void>((r) => httpServer.listen(0, r));
    const port = (httpServer.address() as AddressInfo).port;
    requester = await connect(port, REQUESTER_ID);
    stranger = await connect(port, STRANGER_ID);
  });

  afterAll(async () => {
    for (const c of [requester, stranger]) c?.disconnect();
    await new Promise<void>((r) => io.close(() => r()));
    await new Promise<void>((r) => httpServer.close(() => r()));
    mock.disconnect();
  });

  it("rejects a non-participant", async () => {
    const ack = await advance(stranger, "verifying");
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error).toBe("not-a-participant");
  });

  it("rejects setting `matched` via a free advance", async () => {
    const ack = await advance(requester, "matched");
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error).toBe("illegal-target");
  });

  it("rejects an illegal transition (matched → completed)", async () => {
    const ack = await advance(requester, "completed");
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error).toContain("illegal-transition");
  });

  it("walks the full legal lifecycle, broadcasting task-updated at each step", async () => {
    const seen: TaskState[] = [];
    requester.on("task-updated", ({ task }) => seen.push(task.state));

    const path: TaskState[] = ["verifying", "en-route", "arrived", "in-progress", "completed"];
    for (const to of path) {
      const ack = await advance(requester, to);
      expect(ack.ok).toBe(true);
      if (ack.ok) expect(ack.task.state).toBe(to);
    }

    // Give the broadcasts a tick to arrive.
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(path);

    const finalTask = await tasks.get(TASK_ID);
    expect(finalTask?.state).toBe("completed");
    // updatedAt advanced from the injected clock — proves the repo honors the patch.
    expect(finalTask?.updatedAt).toBe(1_700_000_050_000);
  });

  it("rejects advancing a terminal (completed) task", async () => {
    const ack = await advance(requester, "in-progress");
    expect(ack.ok).toBe(false);
  });
});
