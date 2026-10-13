import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import RedisMock from "ioredis-mock";
import request from "supertest";
import jwt from "jsonwebtoken";
import { config } from "../../config.js";
import type { RedisClient } from "../../redis.js";
import { createInMemorySessionRepo, createInMemoryUserRepo } from "../repos.js";
import { createInMemoryKycDocumentRepo } from "../../onboarding/repos.js";
import { createInMemoryAbuseRepo } from "../../domain/abuseStore.js";
import { createInMemoryPhoneBlockRepo } from "../phoneBlocks.js";
import { AuthService } from "../service.js";
import { OtpService } from "../otp.js";
import { ConsoleSmsProvider, SandboxKycProvider } from "../providers.js";
import { createAuthRouter } from "../router.js";
import { signAccessToken, verifyAccessToken } from "../jwt.js";
import { requireAuth, requireStaff } from "../middleware.js";
import { makeUser } from "../types.js";

/**
 * The session-layer findings from the security review, each pinned by a test that fails
 * against the behaviour it replaced:
 *
 *  - staff could sign in on a one-time code alone, skipping the second factor entirely;
 *  - a replayed refresh token was refused but nothing else happened, and two concurrent
 *    refreshes both succeeded;
 *  - a blocked account could still mint access tokens from a live refresh token;
 *  - the verifier took its algorithm from the token;
 *  - staff authority came from the token's role claim rather than the account.
 */

const CODE = "123456";

describe("session hardening", () => {
  let app: Express;
  let redis: RedisClient;
  let clock = 1_700_000_000_000;
  const users = createInMemoryUserRepo();
  const sessions = createInMemorySessionRepo();
  const auth = new AuthService({
    users,
    sessions,
    phoneBlocks: createInMemoryPhoneBlockRepo(),
    now: () => clock,
  });

  beforeAll(async () => {
    redis = new RedisMock() as unknown as RedisClient;
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
        users,
        documents: createInMemoryKycDocumentRepo(),
        redis,
        abuse: createInMemoryAbuseRepo(),
        now: () => clock,
      }),
    );
    app.get("/staff-only", requireAuth, requireStaff(users, "admin"), (_req, res) => {
      res.json({ ok: true });
    });

    for (const [id, phone, role] of [
      ["hard-admin", "+919000070001", "admin"],
      ["hard-super", "+919000070002", "super_admin"],
      ["hard-req", "+919000070003", "requester"],
    ] as const) {
      await users.create(
        makeUser({
          id,
          phone,
          displayName: id,
          role,
          onboardingStatus: "approved",
          ...(role === "super_admin" ? { username: "hard-root" } : {}),
        }),
      );
    }
  });

  afterAll(() => {
    (redis as unknown as { disconnect(): void }).disconnect();
  });

  beforeEach(() => {
    clock += 60_000;
  });

  const otpLogin = async (phone: string) => {
    await request(app).post("/auth/otp/request").send({ phone });
    return request(app).post("/auth/otp/verify").send({ phone, code: CODE });
  };

  describe("staff and the one-time code", () => {
    it.each([
      ["admin", "+919000070001"],
      ["super_admin", "+919000070002"],
    ])("refuses to sign a %s in on a code alone", async (_role, phone) => {
      const res = await otpLogin(phone);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("password-required");
      // No session of any kind came back with the refusal.
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("still signs an ordinary account in on a code", async () => {
      const res = await otpLogin("+919000070003");
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe("hard-req");
    });

    it("answers a wrong code the same way for staff as for anyone", async () => {
      await request(app).post("/auth/otp/request").send({ phone: "+919000070001" });
      const res = await request(app)
        .post("/auth/otp/verify")
        .send({ phone: "+919000070001", code: "000000" });
      // 401, not the staff-specific 403: without the code, nothing reveals the number is staff.
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("otp-invalid");
    });
  });

  describe("refresh rotation", () => {
    const user = () => users.getById("hard-req").then((u) => u!);

    it("lets only one of two concurrent refreshes through", async () => {
      const first = await auth.issueFor(await user(), "ua");
      const [a, b] = await Promise.all([
        auth.refresh(first.refreshToken, "ua"),
        auth.refresh(first.refreshToken, "ua"),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it("treats a late replay of a rotated token as theft and ends every session", async () => {
      const first = await auth.issueFor(await user(), "ua");
      const second = await auth.refresh(first.refreshToken, "ua");
      expect(second).not.toBeNull();

      // Well past the grace window: the old token is presented again.
      clock += 60_000;
      expect(await auth.refresh(first.refreshToken, "ua")).toBeNull();

      // The token the legitimate rotation produced is dead too — whoever holds it, they
      // sign in again.
      expect(await auth.refresh(second!.refreshToken, "ua")).toBeNull();
    });

    it("does not punish two tabs racing inside the grace window", async () => {
      const first = await auth.issueFor(await user(), "ua");
      const second = await auth.refresh(first.refreshToken, "ua");
      clock += 2_000;
      expect(await auth.refresh(first.refreshToken, "ua")).toBeNull();
      // The winning tab's session survives.
      expect(await auth.refresh(second!.refreshToken, "ua")).not.toBeNull();
    });

    it("mints nothing for a blocked account", async () => {
      await users.create(
        makeUser({
          id: "hard-blocked",
          phone: "+919000070009",
          displayName: "Blocked",
          onboardingStatus: "approved",
        }),
      );
      const issued = await auth.issueFor((await users.getById("hard-blocked"))!, "ua");
      await users.update("hard-blocked", { blockedAt: clock, updatedAt: clock });
      expect(await auth.refresh(issued.refreshToken, "ua")).toBeNull();
    });
  });

  describe("access tokens", () => {
    const claims = { sub: "hard-req", role: "requester", displayName: "x" } as const;

    it("accepts its own tokens", () => {
      expect(verifyAccessToken(signAccessToken(claims))?.sub).toBe("hard-req");
    });

    it("refuses a token signed with a different HMAC variant, even with the right key", () => {
      const other = jwt.sign(claims, config.jwtSecret, { algorithm: "HS512", expiresIn: 60 });
      expect(verifyAccessToken(other)).toBeNull();
    });

    it("refuses an unsigned token", () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const body = Buffer.from(JSON.stringify({ ...claims, exp: 9_999_999_999 })).toString(
        "base64url",
      );
      expect(verifyAccessToken(`${header}.${body}.`)).toBeNull();
    });
  });

  describe("staff authority comes from the account", () => {
    const bearer = (sub: string, role: "admin" | "requester") =>
      `Bearer ${signAccessToken({ sub, role, displayName: sub })}`;

    it("admits a real admin", async () => {
      const res = await request(app)
        .get("/staff-only")
        .set("Authorization", bearer("hard-admin", "admin"));
      expect(res.status).toBe(200);
    });

    it("refuses an ordinary account whose token claims admin", async () => {
      const res = await request(app)
        .get("/staff-only")
        .set("Authorization", bearer("hard-req", "admin"));
      expect(res.status).toBe(403);
    });

    it("refuses an admin the moment they are demoted, with their token still valid", async () => {
      await users.create(
        makeUser({
          id: "hard-demoted",
          phone: "+919000070008",
          displayName: "Was admin",
          role: "admin",
          onboardingStatus: "approved",
        }),
      );
      const token = bearer("hard-demoted", "admin");
      expect((await request(app).get("/staff-only").set("Authorization", token)).status).toBe(200);

      await users.update("hard-demoted", { role: "requester", updatedAt: clock });
      expect((await request(app).get("/staff-only").set("Authorization", token)).status).toBe(403);
    });

    it("refuses a deactivated admin", async () => {
      await users.create(
        makeUser({
          id: "hard-off",
          phone: "+919000070007",
          displayName: "Off",
          role: "admin",
          onboardingStatus: "approved",
        }),
      );
      await users.update("hard-off", { blockedAt: clock, updatedAt: clock });
      const res = await request(app)
        .get("/staff-only")
        .set("Authorization", bearer("hard-off", "admin"));
      expect(res.status).toBe(401);
    });
  });
});
