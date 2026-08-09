import express from "express";
import request from "supertest";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTask, TRANSITION_ACTORS } from "@needy/shared";
import { config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { makeUser } from "../../auth/types.js";
import type { Deps } from "../../domain/deps.js";
import { createInMemoryAbuseRepo } from "../../domain/abuseStore.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { safetyDeps } from "../../test/safetyDeps.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import type { Logger } from "../../logger.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import { createInMemoryServiceCatalog } from "../../services/catalog.js";
import { createHandoffRouter } from "../handoff.js";

/** ── The doorstep handoff ──────────────────────────────────────────────────
 *  Real Redis, because the attempt counter and the rate limiter are Redis behaviour and a
 *  mock would only confirm the mock. Everything else is in-memory.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const KEY_PREFIX = `test:handoff:${process.pid}:${Date.now()}:`;
const NOW = 1_700_000_000_000;

const REQUESTER = "ho-req";
const HELPER = "ho-helper";
const STRANGER = "ho-stranger";
const TASK = "ho-task";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A no-op socket layer: this suite is about the HTTP contract, and the broadcast is
 *  best-effort by design (the handler catches its own failures). */
const io = {
  of: () => ({ to: () => ({ emit: () => {} }) }),
} as unknown as Deps["io"];

describe("doorstep handoff", () => {
  let app: express.Express;
  let redisRaw: Redis;
  let tasks: ReturnType<typeof createInMemoryTaskRepo>;
  let abuse: ReturnType<typeof createInMemoryAbuseRepo>;
  let clock = NOW;

  const token = (sub: string) =>
    signAccessToken({ sub, role: "both", displayName: sub, kyc: "verified" });
  const asHelper = (r: request.Test) => r.set("authorization", `Bearer ${token(HELPER)}`);
  const asRequester = (r: request.Test) => r.set("authorization", `Bearer ${token(REQUESTER)}`);

  const users = createInMemoryUserRepo();

  beforeAll(async () => {
    redisRaw = new Redis(REDIS_URL, { keyPrefix: KEY_PREFIX, db: 13 });
    await redisRaw.flushdb();
    for (const id of [REQUESTER, HELPER, STRANGER]) {
      await users.create(
        makeUser({
          id,
          phone: `+91900000${id.length}${id.slice(-3).charCodeAt(0)}`.slice(0, 13),
          displayName: id,
          role: "both",
          kycStatus: "verified",
          onboardingStatus: "approved",
          dateOfBirth: "1985-06-15",
          gender: "male",
        }),
      );
    }
  });

  afterAll(async () => {
    await redisRaw.flushdb();
    await redisRaw.quit();
  });

  beforeEach(async () => {
    clock = NOW;
    await redisRaw.flushdb();
    tasks = createInMemoryTaskRepo();
    abuse = createInMemoryAbuseRepo();
    await tasks.create(
      makeTask({
        id: TASK,
        requesterId: REQUESTER,
        helperId: HELPER,
        category: "errand",
        state: "arrived",
        origin: { lat: 12.97, lng: 77.59 },
        title: "Pick up medicine",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );

    const client = redisRaw as unknown as RedisClient;
    const deps: Deps = {
      io,
      redis: { client, pub: client, sub: client } as unknown as RedisClients,
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
      // Overrides the default from `safetyDeps` so the burn case below can assert on the
      // signal the limiter emits, rather than trusting that it does.
      abuse,
      now: () => clock,
    };
    app = express();
    app.use(express.json());
    app.use(createHandoffRouter(deps));
  });

  const postBrief = (brief = "I will walk you to the clinic and wait. I cannot carry you.") =>
    asHelper(request(app).post(`/tasks/${TASK}/handoff/brief`)).send({ brief });
  const revealCode = () => asRequester(request(app).post(`/tasks/${TASK}/handoff/code`));
  const verify = (code: string) =>
    asHelper(request(app).post(`/tasks/${TASK}/handoff/verify`)).send({ code });

  /** The rule the whole module rests on. If this ever passes, the handoff is decorative. */
  it("makes in-progress unreachable through the ordinary transition matrix", () => {
    expect(TRANSITION_ACTORS["in-progress"]).toEqual([]);
  });

  it("walks brief -> code -> verify and starts the work", async () => {
    expect((await postBrief()).status).toBe(200);

    const issued = await revealCode();
    expect(issued.status).toBe(200);
    expect(issued.body.code).toMatch(/^\d{6}$/);

    const done = await verify(issued.body.code);
    expect(done.status).toBe(200);

    const after = await tasks.get(TASK);
    expect(after?.state).toBe("in-progress");
    expect(after?.handoffVerifiedAt).toBe(NOW);
    // The credential is destroyed by the same write that advances the state, so a replay
    // finds nothing rather than re-running the transition.
    expect(after?.handoffOtpHash).toBeNull();
  });

  // ── ordering ───────────────────────────────────────────────────────────────

  /** The code means "I have read what you will do and I consent". Issuing one before there is
   *  anything to read would reduce the exchange to a formality. */
  it("refuses to issue a code before the helper has said what they will do", async () => {
    const res = await revealCode();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("brief-required");
  });

  it("refuses to verify when no code has been issued", async () => {
    await postBrief();
    const res = await verify("123456");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no-code-issued");
  });

  it("only operates at the door", async () => {
    await tasks.update(TASK, { state: "en-route", updatedAt: clock });
    expect((await postBrief()).status).toBe(409);
    expect((await revealCode()).status).toBe(409);
    expect((await verify("123456")).status).toBe(409);
  });

  // ── who may do what ────────────────────────────────────────────────────────

  /** The code is shown to the requester and to nobody else — that is what makes entering it
   *  evidence that the helper is standing in front of them. */
  it("never gives the helper the code", async () => {
    await postBrief();
    const res = await asHelper(request(app).post(`/tasks/${TASK}/handoff/code`));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("requester-only");
    expect(JSON.stringify(res.body)).not.toMatch(/\d{6}/);

    // Nor through the status endpoint.
    const status = await asHelper(request(app).get(`/tasks/${TASK}/handoff`));
    expect(status.body).not.toHaveProperty("code");
  });

  it("does not let the requester verify on the helper's behalf", async () => {
    await postBrief();
    const issued = await revealCode();
    const res = await asRequester(request(app).post(`/tasks/${TASK}/handoff/verify`)).send({
      code: issued.body.code,
    });
    expect(res.status).toBe(403);
    expect((await tasks.get(TASK))?.state).toBe("arrived");
  });

  /** A non-participant gets 404, not 403: whether a given task exists is not their business,
   *  and a 403 would confirm it. */
  it("hides the task from a non-participant", async () => {
    const res = await request(app)
      .get(`/tasks/${TASK}/handoff`)
      .set("authorization", `Bearer ${token(STRANGER)}`);
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    expect((await request(app).get(`/tasks/${TASK}/handoff`)).status).toBe(401);
  });

  // ── the code itself ────────────────────────────────────────────────────────

  it("rejects a wrong code and counts down the attempts", async () => {
    await postBrief();
    await revealCode();

    const first = await verify("000000");
    // A correct guess on the first try is a 1-in-a-million fluke; if it ever happens the
    // assertion below is the thing that flags it rather than a silent pass.
    expect(first.status).toBe(401);
    expect(first.body.attemptsRemaining).toBe(4);
    expect((await tasks.get(TASK))?.state).toBe("arrived");
  });

  /** Burning beats locking: the requester reveals a new code with one tap, and an attacker
   *  loses whatever they had narrowed down. */
  it("burns the code after repeated failures rather than locking the task", async () => {
    await postBrief();
    const issued = await revealCode();

    // Exactly the budget: four rejections that count down, then the fifth burns it.
    for (let i = 0; i < 4; i++) {
      const res = await verify(`10000${i}`);
      expect(res.status, `attempt ${i + 1}`).toBe(401);
      expect(res.body.attemptsRemaining).toBe(4 - i);
    }
    const burned = await verify("199999");
    expect(burned.status).toBe(429);
    expect(burned.body.codeBurned).toBe(true);

    // Burning the code is the strongest abuse signal this system produces: the code travels
    // by voice from the requester to the person in front of them, so five failures means the
    // person at the door and the person holding the phone are not talking to each other.
    // Recorded against the HELPER, who is the one entering codes.
    const signals = await abuse.listForSubject(HELPER, 0, 10);
    expect(signals.map((s) => s.kind)).toEqual(["handoff.code_burned"]);
    expect(signals[0]!.taskId).toBe(TASK);
    expect(await abuse.listForSubject(REQUESTER, 0, 10)).toHaveLength(0);

    // The originally-issued code is now dead, so even the right answer does nothing.
    const withRealCode = await verify(issued.body.code);
    expect(withRealCode.status).not.toBe(200);
    expect((await tasks.get(TASK))?.state).toBe("arrived");

    // …but the requester can simply issue another.
    const reissued = await revealCode();
    expect(reissued.status).toBe(200);
    expect(reissued.body.code).toMatch(/^\d{6}$/);
  });

  it("expires a code that is never used", async () => {
    await postBrief();
    const issued = await revealCode();
    clock += 16 * 60 * 1000; // past the 15-minute window

    const res = await verify(issued.body.code);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe("code-expired");
    expect((await tasks.get(TASK))?.state).toBe("arrived");
  });

  /** Re-revealing must invalidate what came before, or a code read out and abandoned an hour
   *  ago would still open the door. */
  it("invalidates the previous code when a new one is issued", async () => {
    await postBrief();
    const firstCode = (await revealCode()).body.code as string;
    const secondCode = (await revealCode()).body.code as string;
    expect(secondCode).not.toBe(firstCode);

    expect((await verify(firstCode)).status).toBe(401);
    expect((await verify(secondCode)).status).toBe(200);
  });

  it("stores only a hash of the code", async () => {
    await postBrief();
    const issued = await revealCode();
    const stored = await tasks.get(TASK);
    expect(stored?.handoffOtpHash).toBeTruthy();
    expect(stored?.handoffOtpHash).not.toBe(issued.body.code);
    expect(stored?.handoffOtpHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── the brief ──────────────────────────────────────────────────────────────

  it("requires a brief with actual content", async () => {
    const res = await asHelper(request(app).post(`/tasks/${TASK}/handoff/brief`)).send({
      brief: "ok",
    });
    expect(res.status).toBe(400);
  });

  it("shows the requester exactly what the helper wrote", async () => {
    const brief = "I will collect your prescription and bring it back. I will not drive you.";
    await postBrief(brief);
    const res = await asRequester(request(app).get(`/tasks/${TASK}/handoff`));
    expect(res.body.serviceBrief).toBe(brief);
  });
});
