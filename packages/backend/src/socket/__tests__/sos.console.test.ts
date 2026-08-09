import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { Redis } from "ioredis";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  makeSosAlert,
  makeTask,
  NS,
  type SocketErrorPayload,
  type SosAlert,
  type SosClientEvents,
  type SosServerEvents,
} from "@needy/shared";
import { createSosAdminRouter } from "../../admin/sos.js";
import type { AuditEntry, AuditLogger } from "../../audit/log.js";
import { signAccessToken } from "../../auth/jwt.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { makeUser, type Role } from "../../auth/types.js";
import { config } from "../../config.js";
import { createInMemoryAbuseRepo } from "../../domain/abuseStore.js";
import type { Deps } from "../../domain/deps.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { createInMemorySosRepo, type SosRepository } from "../../domain/sosStore.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import type { Logger } from "../../logger.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import { createInMemoryServiceCatalog } from "../../services/catalog.js";
import { authMiddleware } from "../auth.js";
import { registerSos } from "../sos.js";

/**
 * ── THE OPERATOR CONSOLE ─────────────────────────────────────────────────────
 *
 * `SOS_OPERATOR_ROOM` existed from the day the SOS namespace was written and NOTHING ever
 * joined it outside a test that joined it by hand, server-side. Every alert was being
 * broadcast to an empty room: the fan-out read as complete in the code and reached no
 * operator in production. There was also no way to own an alert or close one — `acknowledged`
 * was a status in the union that no code path could produce.
 *
 * So this suite drives the real thing end to end: a real socket.io server with the real
 * `registerSos`, the real express admin router, real ioredis for the token bucket, and it
 * asserts on what the OTHER parties actually receive and on what lands in the audit log.
 *
 * What it pins down:
 *   1. An admin subscribing gets the open backlog AND subsequent live alerts.
 *   2. A non-admin is refused the feed and receives nothing afterwards.
 *   3. THE ONE THAT MATTERS: a token that SAYS admin is not enough. Authority is re-read from
 *      the durable user record, so a demoted or blocked admin loses the feed immediately
 *      rather than keeping a window onto every emergency until their token expires.
 *   4. Acknowledging reaches the frightened person over the socket — the console cannot claim
 *      "someone is looking at this" without the raiser being told.
 *   5. Two operators cannot both own one alert, and a resolution cannot be overwritten.
 *   6. Raising and closing an alarm both land in the audit log, which AGENTS.md requires and
 *      which nothing was doing.
 */

type SosSocketClient = ClientSocket<SosServerEvents, SosClientEvents>;
type WatchAck = { ok: true; open: SosAlert[] } | { ok: false; error: string };

const TASK_ID = "task-console-1";
const REQUESTER_ID = "req-console-1";
const HELPER_ID = "helper-console-1";
const ADMIN_ID = "admin-console-1";
/** Role "admin" in their JWT, NOT an admin in the database. */
const IMPOSTOR_ID = "impostor-console-1";
/** A real admin whose account has since been blocked. */
const BLOCKED_ADMIN_ID = "blocked-admin-console-1";
/** Authenticated, ordinary, and a participant of nothing. */
const STRANGER_ID = "stranger-console-1";

const ORIGIN = { lat: 12.9716, lng: 77.5946 };
const FIXED_NOW = 1_700_000_000_000;
const KEY_PREFIX = `test:sos-console:${process.pid}:`;

let clockNow = FIXED_NOW;

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Records what was written so the audit assertions test the real call, not a spy on it. */
function recordingAudit(): AuditLogger & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}

function tokenFor(userId: string, role: Role): string {
  return signAccessToken({ sub: userId, role, displayName: userId, kyc: "verified" });
}

function connect(port: number, userId: string, role: Role): Promise<SosSocketClient> {
  const socket: SosSocketClient = ioClient(`http://localhost:${port}${NS.sos}`, {
    transports: ["websocket"],
    auth: { token: tokenFor(userId, role) },
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

function watch(socket: SosSocketClient): Promise<WatchAck> {
  return new Promise((resolve) => socket.emit("watch", resolve));
}

function raise(socket: SosSocketClient, taskId: string): Promise<{ ok: boolean; alert?: SosAlert }> {
  return new Promise((resolve) =>
    socket.emit("raise", { taskId, kind: "panic", at: ORIGIN }, resolve as never),
  );
}

function nextEvent<K extends "sos-raised" | "sos-updated">(
  socket: SosSocketClient,
  event: K,
  ms = 3_000,
): Promise<SosAlert> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    (socket as unknown as { once: (e: string, cb: (a: SosAlert) => void) => void }).once(
      event,
      (alert) => {
        clearTimeout(timer);
        resolve(alert);
      },
    );
  });
}

function nextError(socket: SosSocketClient, ms = 3_000): Promise<SocketErrorPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for an error")), ms);
    socket.once("error", (payload) => {
      clearTimeout(timer);
      resolve(payload as SocketErrorPayload);
    });
  });
}

/** Assert that nothing arrives. Used where the whole claim is that a refused subscriber is
 *  genuinely not in the room — an assertion that can only be made by waiting. */
function expectNoEvent(socket: SosSocketClient, event: string, ms = 600): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = () => reject(new Error(`unexpectedly received ${event}`));
    socket.once(event as never, handler as never);
    setTimeout(() => {
      socket.off(event as never, handler as never);
      resolve();
    }, ms);
  });
}

describe("SOS operator console", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let redisRaw: Redis;
  let app: express.Express;
  let sos: SosRepository;
  let audit: ReturnType<typeof recordingAudit>;
  let requester: SosSocketClient;
  let admin: SosSocketClient;
  let impostor: SosSocketClient;
  let blockedAdmin: SosSocketClient;
  let stranger: SosSocketClient;
  const tasks = createInMemoryTaskRepo();
  const users = createInMemoryUserRepo();

  beforeAll(async () => {
    redisRaw = new Redis(config.redisUrl, { keyPrefix: KEY_PREFIX });
    const client = redisRaw as unknown as RedisClient;
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    sos = createInMemorySosRepo();
    audit = recordingAudit();

    await users.create(
      makeUser({ id: REQUESTER_ID, phone: "+919000008001", role: "requester", displayName: "Asha" }),
    );
    await users.create(
      makeUser({ id: HELPER_ID, phone: "+919000008002", role: "helper", displayName: "Priya" }),
    );
    await users.create(
      makeUser({ id: ADMIN_ID, phone: "+919000008003", role: "admin", displayName: "Ops" }),
    );
    // Role "both" in the database. Their JWT will claim "admin".
    await users.create(
      makeUser({ id: IMPOSTOR_ID, phone: "+919000008004", role: "both", displayName: "Nope" }),
    );
    await users.create(
      makeUser({
        id: BLOCKED_ADMIN_ID,
        phone: "+919000008005",
        role: "admin",
        displayName: "Suspended",
        blockedAt: FIXED_NOW,
      }),
    );
    await users.create(
      makeUser({ id: STRANGER_ID, phone: "+919000008006", role: "both", displayName: "Nobody" }),
    );

    await tasks.create(
      makeTask({
        id: TASK_ID,
        requesterId: REQUESTER_ID,
        helperId: HELPER_ID,
        category: "errand",
        state: "in-progress",
        origin: ORIGIN,
        title: "Pick up medicine",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }),
    );

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
      users,
      services: createInMemoryServiceCatalog(),
      exceptions: createInMemoryExceptionRepo(),
      audit,
      abuse: createInMemoryAbuseRepo(),
      now: () => clockNow,
    };

    io.of(NS.sos).use(authMiddleware);
    registerSos(deps);

    app = express();
    app.use(express.json());
    app.use(createSosAdminRouter(deps));

    await new Promise<void>((r) => httpServer.listen(0, r));
    const port = (httpServer.address() as AddressInfo).port;

    requester = await connect(port, REQUESTER_ID, "requester");
    admin = await connect(port, ADMIN_ID, "admin");
    impostor = await connect(port, IMPOSTOR_ID, "admin");
    blockedAdmin = await connect(port, BLOCKED_ADMIN_ID, "admin");
    stranger = await connect(port, STRANGER_ID, "both");
  });

  afterAll(async () => {
    for (const c of [requester, admin, impostor, blockedAdmin, stranger]) c?.disconnect();
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    const keys = await redisRaw.keys(`${KEY_PREFIX}*`);
    if (keys.length > 0) {
      await redisRaw.del(...keys.map((k) => k.slice(KEY_PREFIX.length)));
    }
    redisRaw.disconnect();
  });

  // The SOS token bucket is real; move the clock so each case starts with a full one.
  beforeEach(() => {
    clockNow += 60_000;
  });

  // ── who may watch ──────────────────────────────────────────────────────────

  describe("subscribing to the feed", () => {
    /** Deliberately a STRANGER rather than the requester: the requester legitimately receives
     *  `sos-raised` for their own task through their personal room, so using them here would
     *  assert nothing about room membership. */
    it("refuses a non-admin and leaves them out of the room", async () => {
      const errored = nextError(stranger);
      const ack = await watch(stranger);

      expect(ack.ok).toBe(false);
      expect((ack as { error: string }).error).toBe("not-authorized");
      expect((await errored).code).toBe("NOT_AUTHORIZED");

      // The refusal has to mean they are actually not in the room, not merely that the ack
      // said no — a handler that refused and joined anyway would pass an ack-only assertion.
      const silent = expectNoEvent(stranger, "sos-raised");
      await raise(requester, TASK_ID);
      await silent;
    });

    /** The claim this whole design rests on: the JWT is not the authority. */
    it("refuses a token that CLAIMS admin when the account is not one", async () => {
      const ack = await watch(impostor);
      expect(ack.ok).toBe(false);

      const silent = expectNoEvent(impostor, "sos-raised");
      await raise(requester, TASK_ID);
      await silent;
    });

    /** A blocked admin is not an admin, however recently their token was minted. */
    it("refuses a real admin whose account has been blocked", async () => {
      const ack = await watch(blockedAdmin);
      expect(ack.ok).toBe(false);
    });

    it("hands a subscribing admin the open backlog and then live alerts", async () => {
      // A backlog that predates the subscription — the console must not look empty just
      // because it connected late.
      await sos.create(
        makeSosAlert({
          id: "backlog-1",
          taskId: TASK_ID,
          raisedBy: HELPER_ID,
          kind: "unsafe",
          createdAt: FIXED_NOW - 5_000,
          updatedAt: FIXED_NOW - 5_000,
        }),
      );

      const ack = await watch(admin);
      expect(ack.ok).toBe(true);
      expect((ack as { open: SosAlert[] }).open.map((a) => a.id)).toContain("backlog-1");

      // …and the live feed works from here on.
      const live = nextEvent(admin, "sos-raised");
      const raised = await raise(requester, TASK_ID);
      expect((await live).id).toBe(raised.alert!.id);
    });
  });

  // ── owning and closing an alert ────────────────────────────────────────────

  describe("acknowledge and resolve", () => {
    let alertId: string;

    beforeEach(async () => {
      const raised = await raise(requester, TASK_ID);
      alertId = raised.alert!.id;
    });

    it("tells the raiser, over the socket, that a person now has it", async () => {
      const raiserToldPromise = nextEvent(requester, "sos-updated");

      const res = await request(app)
        .post(`/admin/sos/${alertId}/acknowledge`)
        .set("Authorization", `Bearer ${tokenFor(ADMIN_ID, "admin")}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.alert.status).toBe("acknowledged");
      expect(res.body.alert.acknowledgedBy).toBe(ADMIN_ID);
      // The context an operator needs to act without clicking through.
      expect(res.body.alert.requester.displayName).toBe("Asha");
      expect(res.body.alert.helper.displayName).toBe("Priya");
      expect(res.body.alert.raisedByRole).toBe("requester");

      const raiserSaw = await raiserToldPromise;
      expect(raiserSaw.status).toBe("acknowledged");
      expect(raiserSaw.acknowledgedBy).toBe(ADMIN_ID);
    });

    it("lets only the first of two operators own it", async () => {
      const auth = (id: string) => `Bearer ${tokenFor(id, "admin")}`;
      const first = await request(app)
        .post(`/admin/sos/${alertId}/acknowledge`)
        .set("Authorization", auth(ADMIN_ID))
        .send({});
      expect(first.status).toBe(200);

      const second = await request(app)
        .post(`/admin/sos/${alertId}/acknowledge`)
        .set("Authorization", auth(ADMIN_ID))
        .send({});
      // 409 and NOT 200: the second operator is told a colleague has it, which is the truth
      // and is more useful than a silent success overwriting the first name.
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("not-acknowledgeable");
      expect(second.body.acknowledgedBy).toBe(ADMIN_ID);
    });

    /** An alert closed with no explanation is indistinguishable from someone clearing their
     *  queue, which is the entire value of the record afterwards. */
    it("refuses to close an alert without an account of what happened", async () => {
      const res = await request(app)
        .post(`/admin/sos/${alertId}/resolve`)
        .set("Authorization", `Bearer ${tokenFor(ADMIN_ID, "admin")}`)
        .send({ note: "   " });
      expect(res.status).toBe(400);
      expect((await sos.get(alertId))!.status).toBe("raised");
    });

    it("records the resolution and refuses a second one", async () => {
      const auth = `Bearer ${tokenFor(ADMIN_ID, "admin")}`;
      const first = await request(app)
        .post(`/admin/sos/${alertId}/resolve`)
        .set("Authorization", auth)
        .send({ note: "phoned her, the helper had the wrong building" });
      expect(first.status).toBe(200);
      expect(first.body.alert.resolutionNote).toBe(
        "phoned her, the helper had the wrong building",
      );

      const second = await request(app)
        .post(`/admin/sos/${alertId}/resolve`)
        .set("Authorization", auth)
        .send({ note: "actually it was fine" });
      expect(second.status).toBe(409);
      expect((await sos.get(alertId))!.resolutionNote).toBe(
        "phoned her, the helper had the wrong building",
      );
    });

    it("is closed to non-admins", async () => {
      const res = await request(app)
        .post(`/admin/sos/${alertId}/acknowledge`)
        .set("Authorization", `Bearer ${tokenFor(REQUESTER_ID, "requester")}`)
        .send({});
      expect(res.status).toBe(403);
    });

    it("answers 404 for an alert that does not exist, not 409", async () => {
      const res = await request(app)
        .post(`/admin/sos/no-such-alert/acknowledge`)
        .set("Authorization", `Bearer ${tokenFor(ADMIN_ID, "admin")}`)
        .send({});
      expect(res.status).toBe(404);
    });
  });

  // ── the queue ──────────────────────────────────────────────────────────────

  it("lists open alerts oldest first and excludes closed ones", async () => {
    const raised = await raise(requester, TASK_ID);
    await request(app)
      .post(`/admin/sos/${raised.alert!.id}/resolve`)
      .set("Authorization", `Bearer ${tokenFor(ADMIN_ID, "admin")}`)
      .send({ note: "closed for the queue test" });

    const res = await request(app)
      .get("/admin/sos?scope=open")
      .set("Authorization", `Bearer ${tokenFor(ADMIN_ID, "admin")}`);

    expect(res.status).toBe(200);
    const ids = res.body.alerts.map((a: SosAlert) => a.id);
    expect(ids).not.toContain(raised.alert!.id);
    const times = res.body.alerts.map((a: SosAlert) => a.createdAt);
    expect([...times].sort((a: number, b: number) => a - b)).toEqual(times);
  });

  // ── the audit trail ────────────────────────────────────────────────────────

  describe("audit", () => {
    /** AGENTS.md names SOS triggers explicitly, and the action constant had existed since the
     *  log was written with nothing ever recording it. */
    it("records every raise", async () => {
      const before = audit.entries.filter((e) => e.action === "sos.raised").length;
      const raised = await raise(requester, TASK_ID);

      const entry = audit.entries.find(
        (e) => e.action === "sos.raised" && e.subjectId === raised.alert!.id,
      );
      expect(audit.entries.filter((e) => e.action === "sos.raised").length).toBe(before + 1);
      expect(entry?.actorId).toBe(REQUESTER_ID);
      expect(entry?.subjectType).toBe("sos");
    });

    /** The raiser's own note is free text typed by someone in distress. It belongs on the
     *  alert an operator reads deliberately, not in a long-lived table staff can browse. */
    it("keeps the raiser's note out of the audit metadata", async () => {
      const ack = await new Promise<{ ok: boolean; alert?: SosAlert }>((resolve) =>
        requester.emit(
          "raise",
          { taskId: TASK_ID, kind: "medical", note: "my chest hurts and I am alone" },
          resolve as never,
        ),
      );
      const entry = audit.entries.find(
        (e) => e.action === "sos.raised" && e.subjectId === ack.alert!.id,
      );
      expect(JSON.stringify(entry?.metadata)).not.toContain("chest");
      // …but it IS on the alert itself, which is where an operator will read it.
      expect((await sos.get(ack.alert!.id))!.note).toBe("my chest hurts and I am alone");
    });

    it("records who answered and who closed it", async () => {
      const raised = await raise(requester, TASK_ID);
      const auth = `Bearer ${tokenFor(ADMIN_ID, "admin")}`;
      await request(app)
        .post(`/admin/sos/${raised.alert!.id}/acknowledge`)
        .set("Authorization", auth)
        .send({});
      await request(app)
        .post(`/admin/sos/${raised.alert!.id}/resolve`)
        .set("Authorization", auth)
        .send({ note: "false alarm, spoke to both" });

      const acked = audit.entries.find(
        (e) => e.action === "sos.acknowledged" && e.subjectId === raised.alert!.id,
      );
      const resolved = audit.entries.find(
        (e) => e.action === "sos.resolved" && e.subjectId === raised.alert!.id,
      );
      expect(acked?.actorId).toBe(ADMIN_ID);
      // How long the alarm waited for a human is the number this platform should be judged on.
      expect(typeof acked?.metadata?.waitedMs).toBe("number");
      expect(resolved?.metadata?.note).toBe("false alarm, spoke to both");
      expect(resolved?.metadata?.wasAcknowledged).toBe(true);
    });
  });
});
