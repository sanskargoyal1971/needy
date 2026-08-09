import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { createInMemoryServiceCatalog } from "../../services/catalog.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { safetyDeps } from "../../test/safetyDeps.js";
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
  /** The assigned helper. Needed because the helper-driven edges of the lifecycle can no
   *  longer be driven by the requester (audit B12 — see the walk below). */
  let helper: AppClient;
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
      description: "test", price: 100, serviceCode: null, scheduledFor: null, serviceBrief: null, handoffOtpHash: null, handoffOtpExpiresAt: null, handoffVerifiedAt: null, createdAt: 1_700_000_000_000,
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
      // `sos` and `users` are new required Deps fields. Neither is reachable from
      // `advance-task`, so empty in-memory repos keep the container type-complete without
      // adding fixtures this suite would never read.
      sos: createInMemorySosRepo(),
      users: createInMemoryUserRepo(),
      services: createInMemoryServiceCatalog(),
      exceptions: createInMemoryExceptionRepo(),
      ...safetyDeps(),
      now: () => 1_700_000_050_000,
    };
    io.of(NS.matching).use(authMiddleware);
    registerMatching(deps);

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

    // MECHANICAL UPDATE (audit B12): this walk used to drive every edge from the requester's
    // socket, which is precisely the defect the shared TRANSITION_ACTORS matrix now refuses —
    // a requester declaring the helper `en-route`/`arrived`/`in-progress`. Each step is now
    // driven by the actor the matrix names for it; the lifecycle path and every assertion
    // below are unchanged. Role coverage itself lives in matching.authz.test.ts.
    // `in-progress` is absent from this walk on purpose. It is no longer advanceable by
    // anyone: work starts only through the doorstep handoff (brief -> code -> entry), which
    // is a two-sided confirmation and has its own suite. Leaving it here would assert that
    // the handoff is skippable with one socket frame — the exact thing that must not be true.
    const path: TaskState[] = ["verifying", "en-route", "arrived"];
    const actorFor: Record<string, AppClient> = {
      verifying: requester, //   either party may open verification
      "en-route": helper, //     physical-progress claims belong to the person moving
      arrived: helper,
    };
    for (const to of path) {
      const ack = await advance(actorFor[to]!, to);
      expect(ack.ok).toBe(true);
      if (ack.ok) expect(ack.task.state).toBe(to);
    }

    // And prove the closure directly: neither party can declare work started.
    for (const actor of [helper, requester]) {
      const refused = await advance(actor, "in-progress");
      expect(refused.ok).toBe(false);
    }

    // Move to in-progress the only way there is, so `completed` (requester-only) is reachable.
    await tasks.update(TASK_ID, { state: "in-progress", updatedAt: 1_700_000_050_000 });
    const closed = await advance(requester, "completed");
    expect(closed.ok).toBe(true);

    // Give the broadcasts a tick to arrive. The out-of-band `in-progress` write above is a
    // repository call, not an advance, so it broadcasts nothing — hence `completed` follows
    // `arrived` directly in what the requester's socket saw.
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([...path, "completed"]);

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
