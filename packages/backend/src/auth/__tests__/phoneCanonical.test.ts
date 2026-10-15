import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import RedisMock from "ioredis-mock";
import request from "supertest";
import type { RedisClient } from "../../redis.js";
import { PgHarness } from "../../test/pgHarness.js";
import { phoneIndex, pii } from "../../crypto/pii.js";
import { createInMemorySessionRepo, createInMemoryUserRepo, createPgUserRepo } from "../repos.js";
import { createInMemoryKycDocumentRepo } from "../../onboarding/repos.js";
import { createInMemoryAbuseRepo } from "../../domain/abuseStore.js";
import { createInMemoryPhoneBlockRepo } from "../phoneBlocks.js";
import { AuthService } from "../service.js";
import { createInMemoryTotpRepo } from "../totpRepo.js";
import { createLoggingAuditLogger } from "../../audit/log.js";
import { OtpService } from "../otp.js";
import { ConsoleSmsProvider, SandboxKycProvider } from "../providers.js";
import { createAuthRouter } from "../router.js";
import { phoneSchema } from "../validation.js";
import { canonicalisePhones, phoneContext } from "../userPii.js";

/**
 * One number, one key. The API used to pass a phone through as typed, so "+919876543210",
 * "919876543210" and "9876543210" were three accounts for one person, and a block on one shape
 * did not stop the others. Pinned at the three places it went wrong: the schema, the sign-in
 * flow end to end, and rows already stored under the old rule.
 */

describe("phoneSchema", () => {
  it.each([
    ["+919876543210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["9876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["+91 98765-43210", "+919876543210"],
    [" (+91) 98765 43210 ", "+919876543210"],
  ])("reads %j as %j", (input, canonical) => {
    expect(phoneSchema.parse(input)).toBe(canonical);
  });

  it.each(["", "abc", "12", "+0123456789", "1".repeat(40)])("refuses %j", (input) => {
    expect(phoneSchema.safeParse(input).success).toBe(false);
  });
});

describe("sign-in treats every shape of a number as the same person", () => {
  const CODE = "123456";
  let app: Express;
  let redis: RedisClient;
  const users = createInMemoryUserRepo();
  const phoneBlocks = createInMemoryPhoneBlockRepo();

  beforeAll(() => {
    redis = new RedisMock() as unknown as RedisClient;
    const auth = new AuthService({
      users,
      sessions: createInMemorySessionRepo(),
      phoneBlocks,
      totp: createInMemoryTotpRepo(),
      now: () => Date.now(),
    });
    app = express();
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth,
        otp: new OtpService(
          redis,
          new ConsoleSmsProvider(),
          { length: 6, ttlSeconds: 300, maxPerHour: 50, maxAttempts: 5, maxPerHourPerIp: 500 },
          () => CODE,
        ),
        kyc: new SandboxKycProvider(),
        totp: createInMemoryTotpRepo(),
        audit: createLoggingAuditLogger(),
        users,
        documents: createInMemoryKycDocumentRepo(),
        redis,
        abuse: createInMemoryAbuseRepo(),
        now: () => Date.now(),
      }),
    );
  });
  afterAll(() => {
    (redis as unknown as { disconnect(): void }).disconnect();
  });

  const signIn = async (phone: string) => {
    await request(app).post("/auth/otp/request").send({ phone });
    return request(app).post("/auth/otp/verify").send({ phone, code: CODE });
  };

  it("lands three shapes of one number on one account", async () => {
    const a = await signIn("+919000088881");
    const b = await signIn("919000088881");
    const c = await signIn("90000 88881");
    expect(a.status).toBe(200);
    expect(b.body.user.id).toBe(a.body.user.id);
    expect(c.body.user.id).toBe(a.body.user.id);
  });

  it("blocks every shape of a blocked number", async () => {
    await phoneBlocks.block("9000088882", "test", null, Date.now());
    for (const shape of ["+919000088882", "919000088882", "09000088882"]) {
      const res = await signIn(shape);
      expect(res.status, shape).not.toBe(200);
      expect(res.body.error, shape).toBe("phone-blocked");
    }
  });
});

describe("canonicalisePhones re-keys rows stored under the old rule", () => {
  const harness = new PgHarness();
  let pool: pg.Pool;

  /** A row exactly as an older build wrote it: sealed and indexed as typed. */
  const insertLegacy = async (id: string, typed: string) => {
    await pool.query(
      `INSERT INTO users (id, phone_enc, phone_hash, phone_last4, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Legacy', 1, 1)`,
      [id, pii.encrypt(typed, phoneContext(id)), pii.blindIndex("phone", typed), typed.slice(-4)],
    );
  };

  beforeAll(async () => {
    await harness.connect();
    pool = await harness.freshDb("phone_canonical");
    await insertLegacy("k1", "9100000011");
    await insertLegacy("k2", "919100000022");
    await insertLegacy("k3", "+919100000033");
    // The same person as k3, registered a second time without the +91.
    await insertLegacy("k4", "9100000033");
    await pool.query(
      `INSERT INTO phone_blocks (phone_hmac, reason, blocked_at) VALUES ($1, 'old', 1)`,
      [pii.blindIndex("phone", "9100000011")],
    );
  });
  afterAll(async () => {
    await harness.dropAll();
  });

  it("re-keys the stragglers, leaves the duplicate for a human, and moves the block", async () => {
    const warned: unknown[] = [];
    const result = await canonicalisePhones(pool, {
      info: () => {},
      warn: (_msg: string, meta?: unknown) => void warned.push(meta),
    });
    expect(result).toEqual({ rekeyed: 2, conflicts: 1 });
    expect(warned).toEqual([{ userId: "k4" }]);

    const users = createPgUserRepo(pool);
    expect((await users.getByPhone("+919100000011"))?.id).toBe("k1");
    expect((await users.getByPhone("9100000022"))?.id).toBe("k2");
    expect((await users.getByPhone("9100000033"))?.id).toBe("k3");
    expect((await users.getById("k1"))?.phone).toBe("+919100000011");

    const { rows } = await pool.query(`SELECT 1 FROM phone_blocks WHERE phone_hmac = $1`, [
      phoneIndex("+919100000011"),
    ]);
    expect(rows).toHaveLength(1);

    // Idempotent: a second boot finds nothing to do, and still refuses the duplicate.
    expect(await canonicalisePhones(pool, { info: () => {}, warn: () => {} })).toEqual({
      rekeyed: 0,
      conflicts: 1,
    });
  });
});
