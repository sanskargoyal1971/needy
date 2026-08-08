import express, { type Express } from "express";
import RedisMock from "ioredis-mock";
import request from "supertest";
import type { Server } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import type { Deps } from "../../domain/deps.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import { createInMemorySessionRepo, createInMemoryUserRepo } from "../repos.js";
import { AuthService } from "../service.js";
import { OtpService } from "../otp.js";
import {
  ConsoleSmsProvider,
  SandboxKycProvider,
  signKycCallback,
} from "../providers.js";

/**
 * Authorization hardening regressions (audit A4, A5, B8, C15). Each test below pins a specific
 * hole that was reachable by an unauthenticated or under-privileged caller, so re-opening any of
 * them fails the suite rather than shipping:
 *
 *  A4  — POST /dev/token mints a token for ANY userId with ANY role and was mounted
 *         unconditionally; in production the route must not EXIST (404, not a guarded 403).
 *  A5  — the KYC callback was unauthenticated, its references were guessable, it trusted a
 *         userId from its own body, and the sandbox provider failed OPEN.
 *  C15 — re-requesting an OTP reset the attempt budget.
 *  B8  — /health returned a static {ok:true} and reported healthy with dependencies down.
 *
 * `config` is read at MODULE IMPORT time (by design — misconfiguration should fail fast at
 * boot), so the environment-sensitive tests stub NODE_ENV and then `vi.resetModules()` +
 * dynamic-import so the module graph is re-evaluated against that env. The production behaviour
 * is NOT loosened to make it testable: the router genuinely never registers the route.
 */

const NOW = 1_700_000_000_000;
const CODE = "123456";

/** Build a Deps container around ioredis-mock. `overrides` lets a test degrade one dependency. */
function makeDeps(redisClient: RedisClient, config: Deps["config"]): Deps {
  return {
    io: {} as unknown as Server,
    redis: { client: redisClient, pub: redisClient, sub: redisClient } as unknown as RedisClients,
    logger,
    config,
    tasks: createInMemoryTaskRepo(),
    messages: createInMemoryMessageRepo(),
    helpers: createInMemoryHelperProfileRepo({}),
    sos: createInMemorySosRepo(),
    users: createInMemoryUserRepo(),
    now: () => NOW,
  };
}

/**
 * Import config + the HTTP router fresh under a given NODE_ENV. Both modules read `config` at
 * import time, so nothing short of a module-graph reset can exercise the production branch.
 */
async function loadHttpRouterUnderEnv(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  // A production config refuses to boot on the development default secrets (config.ts), so
  // supply real ones — this test is about route mounting, not the secret checks.
  vi.stubEnv("JWT_SECRET", "x".repeat(48));
  vi.stubEnv("KYC_CALLBACK_SECRET", "y".repeat(48));
  const { config } = await import("../../config.js");
  const { createHttpRouter } = await import("../../http/router.js");
  return { config, createHttpRouter };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ── A4: /dev/token must not exist outside development/test ───────────────────

describe("audit A4 — POST /dev/token is a dev-only affordance", () => {
  it("does not exist under NODE_ENV=production (404, not a guarded 403)", async () => {
    const { config, createHttpRouter } = await loadHttpRouterUnderEnv("production");
    expect(config.env).toBe("production");
    expect(config.allowDevRoutes).toBe(false);

    const redis = new RedisMock() as unknown as RedisClient;
    const app = express();
    app.use(express.json());
    app.use(createHttpRouter(makeDeps(redis, config)));

    const res = await request(app)
      .post("/dev/token")
      .send({ userId: "victim", role: "helper", displayName: "Mallory" });

    // 404 specifically: a 403 would confirm to a prober that a token-minting endpoint lives
    // here. And critically — no token, under any status code.
    expect(res.status).toBe(404);
    expect(res.body.token).toBeUndefined();

    (redis as unknown as { disconnect(): void }).disconnect();
  });

  it("mints a token under NODE_ENV=development (the affordance still works locally)", async () => {
    const { config, createHttpRouter } = await loadHttpRouterUnderEnv("development");
    expect(config.allowDevRoutes).toBe(true);

    const redis = new RedisMock() as unknown as RedisClient;
    const app = express();
    app.use(express.json());
    app.use(createHttpRouter(makeDeps(redis, config)));

    const res = await request(app)
      .post("/dev/token")
      .send({ userId: "dev-1", role: "helper", displayName: "Dev" });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");

    // Still validated: a bogus role is refused rather than cast through (it feeds JWT claims).
    const bad = await request(app)
      .post("/dev/token")
      .send({ userId: "dev-1", role: "admin", displayName: "Dev" });
    expect(bad.status).toBe(400);

    (redis as unknown as { disconnect(): void }).disconnect();
  });
});

// ── B8/health: readiness must reflect real dependency state ──────────────────

describe("audit B8 — GET /health probes its dependencies", () => {
  it("returns 200 with dependencies up", async () => {
    const { config, createHttpRouter } = await loadHttpRouterUnderEnv("test");
    const redis = new RedisMock() as unknown as RedisClient;
    const app = express();
    app.use(createHttpRouter(makeDeps(redis, config)));

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dependencies.redis).toBe("ok");
    // No pool passed = in-memory mode; "not configured" is healthy, not down.
    expect(res.body.dependencies.database).toBe("not-configured");

    (redis as unknown as { disconnect(): void }).disconnect();
  });

  it("returns 503 when Redis is unreachable", async () => {
    const { config, createHttpRouter } = await loadHttpRouterUnderEnv("test");
    const redis = new RedisMock() as unknown as RedisClient;
    // A dead connection: ioredis rejects commands rather than answering PING.
    vi.spyOn(redis, "ping").mockRejectedValue(new Error("ECONNREFUSED"));

    const app = express();
    app.use(createHttpRouter(makeDeps(redis, config), { healthProbeTimeoutMs: 200 }));

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.dependencies.redis).toBe("unavailable");

    (redis as unknown as { disconnect(): void }).disconnect();
  });

  it("returns 503 when Postgres is unreachable", async () => {
    const { config, createHttpRouter } = await loadHttpRouterUnderEnv("test");
    const redis = new RedisMock() as unknown as RedisClient;
    // Minimal pool stand-in: /health only ever issues SELECT 1.
    const db = {
      query: () => Promise.reject(new Error("connection refused")),
    } as unknown as Parameters<typeof createHttpRouter>[1] extends undefined
      ? never
      : NonNullable<NonNullable<Parameters<typeof createHttpRouter>[1]>["db"]>;

    const app = express();
    app.use(createHttpRouter(makeDeps(redis, config), { db, healthProbeTimeoutMs: 200 }));

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.dependencies.redis).toBe("ok");
    expect(res.body.dependencies.database).toBe("unavailable");

    (redis as unknown as { disconnect(): void }).disconnect();
  });

  it("returns 503 when a dependency hangs instead of failing", async () => {
    const { config, createHttpRouter } = await loadHttpRouterUnderEnv("test");
    const redis = new RedisMock() as unknown as RedisClient;
    // A wedged dependency never rejects — the probe timeout is what keeps /health honest
    // (and answering at all) instead of hanging every load-balancer check.
    const db = {
      query: () => new Promise(() => {}),
    } as unknown as NonNullable<NonNullable<Parameters<typeof createHttpRouter>[1]>["db"]>;

    const app = express();
    app.use(createHttpRouter(makeDeps(redis, config), { db, healthProbeTimeoutMs: 100 }));

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.dependencies.database).toBe("unavailable");

    (redis as unknown as { disconnect(): void }).disconnect();
  });
});

// ── A5: the KYC callback must be authentic, single-use and subject-bound ──────

describe("audit A5 — KYC callback authenticity", () => {
  let app: Express;
  let redis: RedisClient;
  let users: ReturnType<typeof createInMemoryUserRepo>;
  let secret: string;
  let KYC_SIGNATURE_HEADER_NAME: string;

  /** Drive a real helper through login → role upgrade → kyc/start, returning the reference and
   *  nonce the provider would be given. */
  async function startKycAs(phone: string) {
    const agent = request.agent(app);
    await agent.post("/auth/otp/request").send({ phone });
    await agent.post("/auth/otp/verify").send({ phone, code: CODE });
    await agent.patch("/auth/me").send({ role: "helper" });
    await agent.post("/auth/refresh").send();
    const start = await agent.post("/auth/kyc/start").send();
    expect(start.status).toBe(200);
    const me = await agent.get("/auth/me");
    return {
      agent,
      userId: me.body.user.id as string,
      reference: start.body.reference as string,
      nonce: start.body.callbackNonce as string,
    };
  }

  /** POST a callback with an explicitly chosen signature, so a test can omit or corrupt it. */
  function postCallback(payload: unknown, signature?: string) {
    const raw = JSON.stringify(payload);
    const req = request(app)
      .post("/auth/kyc/callback")
      .set("Content-Type", "application/json");
    if (signature !== undefined) req.set(KYC_SIGNATURE_HEADER_NAME, signature);
    return req.send(raw);
  }

  const signed = (payload: unknown) => postCallback(payload, signKycCallback(JSON.stringify(payload), secret));

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    const { config } = await import("../../config.js");
    const providers = await import("../providers.js");
    const { createAuthRouter, KYC_CALLBACK_PATH, kycRawBodyParser } = await import("../router.js");
    secret = config.auth.kycCallbackSecret;
    KYC_SIGNATURE_HEADER_NAME = providers.KYC_SIGNATURE_HEADER;

    redis = new RedisMock() as unknown as RedisClient;
    users = createInMemoryUserRepo();
    const sessions = createInMemorySessionRepo();
    const now = () => NOW;

    app = express();
    // Raw capture scoped to the callback path only, mounted before the app-wide JSON parser.
    app.use(KYC_CALLBACK_PATH, kycRawBodyParser);
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth: new AuthService({ users, sessions, now }),
        otp: new OtpService(
          redis,
          new ConsoleSmsProvider(),
          { length: 6, ttlSeconds: 300, maxPerHour: 50, maxAttempts: 5, maxPerHourPerIp: 500 },
          () => CODE,
        ),
        kyc: new SandboxKycProvider(),
        users,
        redis,
        now,
      }),
    );
  });

  afterEach(() => {
    (redis as unknown as { disconnect(): void }).disconnect();
  });

  it("rejects an UNSIGNED callback", async () => {
    const { userId, reference, nonce } = await startKycAs("+919876510001");

    const res = await postCallback({ reference, nonce, decision: "verified" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid-signature");
    // The whole point: status is untouched, so an unsigned caller verified nobody.
    expect((await users.getById(userId))!.kycStatus).toBe("pending");
  });

  it("rejects a callback signed with the WRONG secret", async () => {
    const { userId, reference, nonce } = await startKycAs("+919876510002");
    const payload = { reference, nonce, decision: "verified" };

    const res = await postCallback(
      payload,
      signKycCallback(JSON.stringify(payload), "not-the-shared-secret"),
    );
    expect(res.status).toBe(401);
    expect((await users.getById(userId))!.kycStatus).toBe("pending");
  });

  it("rejects a signature computed over DIFFERENT bytes than were sent", async () => {
    const { userId, reference, nonce } = await startKycAs("+919876510003");
    // Sign an approved decision but transmit a body claiming... the same thing. The HMAC is
    // over the raw bytes, so any divergence at all (here: key order) must fail.
    const signature = signKycCallback(
      JSON.stringify({ decision: "verified", nonce, reference }),
      secret,
    );
    const res = await postCallback({ reference, nonce, decision: "verified" }, signature);
    expect(res.status).toBe(401);
    expect((await users.getById(userId))!.kycStatus).toBe("pending");
  });

  it("accepts a correctly-signed callback carrying a valid nonce and verifies the helper", async () => {
    const { userId, reference, nonce } = await startKycAs("+919876510004");

    const res = await signed({ reference, nonce, decision: "verified" });
    expect(res.status).toBe(200);
    expect((await users.getById(userId))!.kycStatus).toBe("verified");
  });

  it("rejects a REPLAYED nonce (single use)", async () => {
    const { userId, reference, nonce } = await startKycAs("+919876510005");

    expect((await signed({ reference, nonce, decision: "verified" })).status).toBe(200);

    // A byte-identical, perfectly-signed replay must not be applied a second time — otherwise a
    // captured callback is a permanently reusable "flip this account" token (e.g. back to
    // verified after an admin rejection).
    await users.update(userId, { kycStatus: "rejected", updatedAt: NOW });
    const replay = await signed({ reference, nonce, decision: "verified" });
    expect(replay.status).toBe(404);
    expect((await users.getById(userId))!.kycStatus).toBe("rejected");
  });

  it("rejects a valid reference presented with the WRONG nonce", async () => {
    const a = await startKycAs("+919876510006");
    const b = await startKycAs("+919876510007");

    // Attacker knows/guesses A's reference but holds only their own nonce.
    const res = await signed({ reference: a.reference, nonce: b.nonce, decision: "verified" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid-nonce");
    expect((await users.getById(a.userId))!.kycStatus).toBe("pending");
  });

  it("cannot verify a DIFFERENT userId named in the callback body", async () => {
    const victim = await startKycAs("+919876510008");
    const attacker = await startKycAs("+919876510009");

    // Attacker uses their OWN (legitimate, signed, valid) callback but names the victim as the
    // subject. The body's userId is ignored: the subject comes from the stored nonce record.
    const res = await signed({
      reference: attacker.reference,
      nonce: attacker.nonce,
      decision: "verified",
      userId: victim.userId,
    });
    expect(res.status).toBe(200);

    // The attacker verified only themselves; the victim is untouched.
    expect((await users.getById(attacker.userId))!.kycStatus).toBe("verified");
    expect((await users.getById(victim.userId))!.kycStatus).toBe("pending");
  });

  it("does not leak a guessable reference (no userId or timestamp in it)", async () => {
    const { userId, reference } = await startKycAs("+919876510010");
    expect(reference).not.toContain(userId);
    // The old scheme was `sandbox_<userId>_<base36 Date.now()>` — fully derivable.
    expect(reference).not.toContain(NOW.toString(36));
    expect(reference.length).toBeGreaterThan(32);
  });

  it("refuses a signed callback with an unrecognised decision, leaving status untouched", async () => {
    const { userId, reference, nonce } = await startKycAs("+919876510011");

    // Correctly signed and correctly nonced, but the decision is not a decision we understand.
    const res = await signed({ reference, nonce, decision: "approved" });
    expect(res.status).toBe(400);
    expect((await users.getById(userId))!.kycStatus).toBe("pending");
  });
});

// ── A5(d): the provider itself must fail closed ──────────────────────────────

describe("audit A5(d) — SandboxKycProvider.interpretCallback fails CLOSED", () => {
  const kyc = new SandboxKycProvider();

  it("verifies ONLY on an explicit positive decision", () => {
    expect(kyc.interpretCallback({ reference: "r", decision: "verified" })).toEqual({
      reference: "r",
      decision: "verified",
    });
    expect(kyc.interpretCallback({ reference: "r", decision: "rejected" })).toEqual({
      reference: "r",
      decision: "rejected",
    });
  });

  it("returns null for any unrecognised decision instead of defaulting to verified", () => {
    // It used to be `decision === "rejected" ? "rejected" : "verified"`, so EVERY value below
    // verified the user — including the absence of a decision entirely.
    for (const decision of [
      undefined,
      null,
      "",
      "approved",
      "VERIFIED",
      "pending",
      "unverified",
      0,
      1,
      true,
      {},
      ["verified"],
    ]) {
      expect(kyc.interpretCallback({ reference: "r", decision })).toBeNull();
    }
    expect(kyc.interpretCallback({ reference: "r" })).toBeNull();
    expect(kyc.interpretCallback({ decision: "verified" })).toBeNull();
    expect(kyc.interpretCallback(null)).toBeNull();
    expect(kyc.interpretCallback("verified")).toBeNull();
  });
});

// ── ConsoleSmsProvider must not put a credential in the log ──────────────────

describe("ConsoleSmsProvider does not log a usable credential at info", () => {
  it("masks the phone number and never puts the OTP in an info line", async () => {
    const infos: unknown[][] = [];
    // The logger writes info via console.log and warn/error via console.error.
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      infos.push(args);
    });
    try {
      await new ConsoleSmsProvider().send("+919876543210", "Your Needy verification code is 424242.");
    } finally {
      log.mockRestore();
    }

    const infoLines = infos
      .map((a) => String(a[0]))
      .filter((line) => line.includes('"level":"info"'));
    expect(infoLines.length).toBeGreaterThan(0);
    for (const line of infoLines) {
      // The OTP itself is a credential — it must not be in the info stream at all.
      expect(line).not.toContain("424242");
      // Nor the full E.164 number (it used to be logged verbatim alongside the code).
      expect(line).not.toContain("+919876543210");
    }
  });
});

// ── C15: OTP budgets must actually be budgets ────────────────────────────────

describe("audit C15 — OTP attempt budget", () => {
  let redis: RedisClient;
  let otp: OtpService;
  const PHONE = "+919876520001";
  const IP = "203.0.113.7";

  beforeEach(() => {
    redis = new RedisMock() as unknown as RedisClient;
    otp = new OtpService(
      redis,
      new ConsoleSmsProvider(),
      { length: 6, ttlSeconds: 300, maxPerHour: 5, maxAttempts: 3, maxPerHourPerIp: 100 },
      () => CODE,
    );
  });

  afterEach(() => {
    (redis as unknown as { disconnect(): void }).disconnect();
  });

  it("does not reset attempts when a fresh code is requested", async () => {
    expect((await otp.request(PHONE, IP)).ok).toBe(true);

    // Burn the whole attempt budget on wrong guesses.
    for (let i = 0; i < 3; i++) {
      expect(await otp.verify(PHONE, "000000")).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await otp.verify(PHONE, "000000")).toEqual({
      ok: false,
      reason: "too-many-attempts",
    });

    // Requesting a new code used to `del` the attempts key, handing the budget straight back:
    // 5 codes/hour × 5 attempts = 25 guesses against a 6-digit code instead of 5. Now the
    // window survives the re-request, so even the CORRECT code is refused until it expires.
    expect((await otp.request(PHONE, IP)).ok).toBe(true);
    expect(await otp.verify(PHONE, CODE)).toEqual({ ok: false, reason: "too-many-attempts" });
  });

  it("charges an attempt for probing a phone with no live code", async () => {
    // No request() at all — nothing was ever sent to this number.
    const probe = "+919876520002";
    expect(await otp.verify(probe, "000000")).toEqual({ ok: false, reason: "expired" });
    expect(await otp.verify(probe, "000000")).toEqual({ ok: false, reason: "expired" });
    expect(await otp.verify(probe, "000000")).toEqual({ ok: false, reason: "expired" });
    // The 4th call is over the cap: probing used to be FREE because `expired` returned before
    // the attempt was charged, so an attacker could poll indefinitely to learn exactly when a
    // real code existed for a number and only then start spending attempts.
    expect(await otp.verify(probe, "000000")).toEqual({
      ok: false,
      reason: "too-many-attempts",
    });
  });

  it("still lets a legitimate first-try verification through", async () => {
    const phone = "+919876520003";
    expect((await otp.request(phone, IP)).ok).toBe(true);
    expect(await otp.verify(phone, CODE)).toEqual({ ok: true });
    // Code is consumed, so a replay fails.
    expect(await otp.verify(phone, CODE)).toEqual({ ok: false, reason: "expired" });
  });

  it("rate-limits OTP requests per source IP across many phone numbers", async () => {
    const bomber = new OtpService(
      redis,
      new ConsoleSmsProvider(),
      { length: 6, ttlSeconds: 300, maxPerHour: 5, maxAttempts: 5, maxPerHourPerIp: 4 },
      () => CODE,
    );
    const ip = "198.51.100.9";
    // Each number is fresh, so the per-phone cap never trips — this is exactly the SMS-bombing
    // path that was unbounded before: one host, unlimited numbers, unlimited messages.
    for (let i = 0; i < 4; i++) {
      const res = await bomber.request(`+91987653${String(1000 + i)}`, ip);
      expect(res.ok).toBe(true);
    }
    const blocked = await bomber.request("+919876539999", ip);
    expect(blocked).toEqual({ ok: false, reason: "rate-limited", scope: "ip" });

    // A different source address is unaffected — the limiter bounds a bomber, not the world.
    expect((await bomber.request("+919876539998", "198.51.100.10")).ok).toBe(true);
  });
});
