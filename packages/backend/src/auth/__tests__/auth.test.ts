import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import RedisMock from "ioredis-mock";
import request from "supertest";
import { config } from "../../config.js";
import type { RedisClient } from "../../redis.js";
import { createInMemorySessionRepo, createInMemoryUserRepo } from "../repos.js";
import { createInMemoryKycDocumentRepo } from "../../onboarding/repos.js";
import { createInMemoryAbuseRepo } from "../../domain/abuseStore.js";
import { createInMemoryPhoneBlockRepo } from "../phoneBlocks.js";
import { AuthService } from "../service.js";
import { createInMemoryTotpRepo } from "../totpRepo.js";
import { createLoggingAuditLogger } from "../../audit/log.js";
import { OtpService } from "../otp.js";
import {
  ConsoleSmsProvider,
  KYC_SIGNATURE_HEADER,
  SandboxKycProvider,
  signKycCallback,
} from "../providers.js";
import { createAuthRouter, KYC_CALLBACK_PATH, kycRawBodyParser } from "../router.js";

/**
 * Stage A end-to-end over the real router + services (in-memory repos, ioredis-mock). Proves
 * the OTP → login → cookie → refresh-rotation → logout lifecycle, rate/attempt limits, input
 * validation, and API-layer role enforcement (a requester is refused a helper-only endpoint).
 */

const CODE = "123456";
const NOW = 1_700_000_000_000;

/** POST a KYC callback the way an authentic provider does: exact raw bytes, HMAC over those
 *  bytes. Audit A5 made signing mandatory, so every caller of this endpoint — tests included —
 *  now has to go through the real authenticity path. */
function postSignedKycCallback(app: Express, payload: unknown, secret?: string) {
  const raw = JSON.stringify(payload);
  return request(app)
    .post(KYC_CALLBACK_PATH)
    .set("Content-Type", "application/json")
    .set(KYC_SIGNATURE_HEADER, signKycCallback(raw, secret ?? config.auth.kycCallbackSecret))
    .send(raw);
}

function setCookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const hit = raw?.find((c) => c.startsWith(`${name}=`));
  return hit?.split(";")[0]?.split("=")[1];
}

describe("Stage A — auth", () => {
  let app: Express;
  let redis: RedisClient;

  beforeAll(() => {
    redis = new RedisMock() as unknown as RedisClient;
    const users = createInMemoryUserRepo();
    const sessions = createInMemorySessionRepo();
    const documents = createInMemoryKycDocumentRepo();
    const phoneBlocks = createInMemoryPhoneBlockRepo();
    const now = () => NOW;
    app = express();
    // The raw-body capture is scoped to the KYC callback path only and mounted BEFORE the
    // app-wide JSON parser, exactly as the composition root does it — the callback's HMAC is
    // over the raw bytes, which express.json() would otherwise have already consumed.
    app.use(KYC_CALLBACK_PATH, kycRawBodyParser);
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth: new AuthService({
          users,
          sessions,
          phoneBlocks,
          totp: createInMemoryTotpRepo(),
          now,
        }),
        otp: new OtpService(
          redis,
          new ConsoleSmsProvider(),
          { length: 6, ttlSeconds: 300, maxPerHour: 5, maxAttempts: 5 },
          () => CODE,
        ),
        kyc: new SandboxKycProvider(),
        totp: createInMemoryTotpRepo(),
        audit: createLoggingAuditLogger(),
        users,
        documents,
        redis,
        abuse: createInMemoryAbuseRepo(),
        now,
      }),
    );
  });

  afterAll(() => {
    (redis as unknown as { disconnect(): void }).disconnect();
  });

  it("rejects a malformed phone number (validation)", async () => {
    const res = await request(app).post("/auth/otp/request").send({ phone: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid-input");
  });

  it("requires auth for /auth/me", async () => {
    const res = await request(app).get("/auth/me");
    expect(res.status).toBe(401);
  });

  it("walks OTP → login → me → refresh-rotation → logout", async () => {
    const agent = request.agent(app);
    const phone = "+919876500001";

    expect((await agent.post("/auth/otp/request").send({ phone })).status).toBe(200);

    const verify = await agent.post("/auth/otp/verify").send({ phone, code: CODE });
    expect(verify.status).toBe(200);
    expect(verify.body.user.phone).toBe(phone);
    expect(verify.body.user.role).toBe("requester");
    const firstRefresh = setCookie(verify, "needy_rt");
    expect(firstRefresh).toBeTruthy();

    // Access cookie authenticates /auth/me.
    const me = await agent.get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.phone).toBe(phone);

    // Refresh rotates the session → a new refresh token.
    const refreshed = await agent.post("/auth/refresh").send();
    expect(refreshed.status).toBe(200);
    const secondRefresh = setCookie(refreshed, "needy_rt");
    expect(secondRefresh).toBeTruthy();
    expect(secondRefresh).not.toBe(firstRefresh);

    // The OLD refresh token is now revoked and must be rejected.
    const replay = await request(app)
      .post("/auth/refresh")
      .set("Cookie", `needy_rt=${firstRefresh}`);
    expect(replay.status).toBe(401);

    // Logout revokes the current session.
    expect((await agent.post("/auth/logout").send()).status).toBe(200);
  });

  it("enforces the OTP request rate limit", async () => {
    const phone = "+919876500002";
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post("/auth/otp/request").send({ phone })).status).toBe(200);
    }
    const sixth = await request(app).post("/auth/otp/request").send({ phone });
    expect(sixth.status).toBe(429);
  });

  it("rejects a wrong OTP code", async () => {
    const phone = "+919876500003";
    await request(app).post("/auth/otp/request").send({ phone });
    const res = await request(app).post("/auth/otp/verify").send({ phone, code: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("invalid");
  });

  it("enforces role at the API layer, and runs the KYC flow after role upgrade", async () => {
    const agent = request.agent(app);
    const phone = "+919876500004";
    await agent.post("/auth/otp/request").send({ phone });
    await agent.post("/auth/otp/verify").send({ phone, code: CODE });

    // A requester may NOT start KYC (helper-only) — the API rejects it, not just the UI.
    const forbidden = await agent.post("/auth/kyc/start").send();
    expect(forbidden.status).toBe(403);

    // Become a helper, then refresh so the new role is reflected in the access token.
    expect((await agent.patch("/auth/me").send({ role: "helper" })).status).toBe(200);
    expect((await agent.post("/auth/refresh").send()).status).toBe(200);

    const start = await agent.post("/auth/kyc/start").send();
    expect(start.status).toBe(200);
    expect(start.body.verificationUrl).toContain("/verify/");
    const reference: string = start.body.reference;
    // Audit A5(b): start now also issues a single-use nonce bound to THIS user, which the
    // callback must present. The reference alone is no longer sufficient (and is no longer
    // guessable — it carries no userId or timestamp).
    const nonce: string = start.body.callbackNonce;
    expect(reference).toBeTruthy();
    expect(nonce).toBeTruthy();

    expect((await agent.get("/auth/kyc/status")).body.kycStatus).toBe("pending");

    // Provider callback confirms verification — signed over the raw body, carrying the nonce.
    const cb = await postSignedKycCallback(app, { reference, nonce, decision: "verified" });
    expect(cb.status).toBe(200);
    expect((await agent.get("/auth/kyc/status")).body.kycStatus).toBe("verified");
  });
});
