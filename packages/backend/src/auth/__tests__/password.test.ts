import { beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import RedisMock from "ioredis-mock";
import request from "supertest";
import type { RedisClient } from "../../redis.js";
import {
  createInMemorySessionRepo,
  createInMemoryUserRepo,
  type InMemoryUserRepository,
} from "../repos.js";
import { createInMemoryKycDocumentRepo } from "../../onboarding/repos.js";
import { createInMemoryAbuseRepo, type AbuseRepository } from "../../domain/abuseStore.js";
import { createInMemoryPhoneBlockRepo } from "../phoneBlocks.js";
import { AuthService } from "../service.js";
import { OtpService } from "../otp.js";
import { ConsoleSmsProvider, SandboxKycProvider } from "../providers.js";
import { createAuthRouter } from "../router.js";
import { hashPassword, passwordProblem, verifyPassword } from "../password.js";
import { makeUser } from "../types.js";

/** ── Password sign-in ──────────────────────────────────────────────────────
 *  The second way a session can come into existence. Until this existed, `loginWithPhone` was
 *  the only one — so these tests are as much about what the new path REFUSES to do as about
 *  what it allows.
 */

const CODE = "123456";
const NOW = 1_700_000_000_000;
const GOOD = "correct horse battery";

const USER_PHONE = "+919876500101";
const ADMIN_PHONE = "+919876500102";

describe("password sign-in", () => {
  let app: Express;
  let redis: RedisClient;
  let users: InMemoryUserRepository;
  let auth: AuthService;
  let abuse: AbuseRepository;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as RedisClient;
    // ioredis-mock shares one keyspace across instances, so a fresh `new RedisMock()` per test
    // is NOT a fresh Redis: the rate-limit case below would otherwise leave a drained bucket
    // behind and every later test on that number would be refused before it began.
    await redis.flushall();
    users = createInMemoryUserRepo();
    const sessions = createInMemorySessionRepo();
    const phoneBlocks = createInMemoryPhoneBlockRepo();
    abuse = createInMemoryAbuseRepo();
    const now = () => NOW;
    auth = new AuthService({ users, sessions, phoneBlocks, now });

    await users.create(
      makeUser({
        id: "u-pw",
        phone: USER_PHONE,
        displayName: "Asha",
        onboardingStatus: "approved",
      }),
    );
    await users.create(
      makeUser({
        id: "u-admin",
        phone: ADMIN_PHONE,
        displayName: "Ops",
        role: "admin",
        onboardingStatus: "approved",
      }),
    );

    app = express();
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth,
        otp: new OtpService(
          redis,
          new ConsoleSmsProvider(),
          { length: 6, ttlSeconds: 300, maxPerHour: 50, maxAttempts: 5 },
          () => CODE,
        ),
        kyc: new SandboxKycProvider(),
        users,
        documents: createInMemoryKycDocumentRepo(),
        redis,
        abuse,
        now,
      }),
    );
  });

  const login = (phone: string, password: string) =>
    request(app).post("/auth/password/login").send({ phone, password });

  // ── the hash itself ────────────────────────────────────────────────────────

  it("round-trips a password and rejects a wrong one", async () => {
    const stored = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD, stored)).toBe(true);
    expect(await verifyPassword("correct horse batteryy", stored)).toBe(false);
  });

  /** Two hashes of the same password must differ, or the column becomes a rainbow table of
   *  which accounts share a password. */
  it("salts, so the same password hashes differently every time", async () => {
    expect(await hashPassword(GOOD)).not.toBe(await hashPassword(GOOD));
  });

  it("never throws on a malformed or absent stored hash", async () => {
    expect(await verifyPassword(GOOD, null)).toBe(false);
    expect(await verifyPassword(GOOD, "")).toBe(false);
    expect(await verifyPassword(GOOD, "not-a-hash")).toBe(false);
    expect(await verifyPassword(GOOD, "scrypt$1$2$3")).toBe(false);
    // A hash claiming an absurd cost would be a memory-exhaustion vector if honoured.
    expect(await verifyPassword(GOOD, "scrypt$999999999$8$1$YQ$Yg")).toBe(false);
  });

  it("refuses a password built from the account's own phone number", () => {
    expect(passwordProblem("9876500101x", USER_PHONE)).toBe("contains-phone");
    expect(passwordProblem("short", USER_PHONE)).toBe("too-short");
    expect(passwordProblem("password123", USER_PHONE)).toBe("too-common");
    expect(passwordProblem(GOOD, USER_PHONE)).toBeNull();
  });

  // ── signing in ─────────────────────────────────────────────────────────────

  it("signs a non-admin in with a password", async () => {
    await auth.setPassword("u-pw", GOOD);
    const res = await login(USER_PHONE, GOOD);
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe(USER_PHONE);
    expect(res.body.csrfToken).toBeTruthy();
    const cookies = (res.headers["set-cookie"] as unknown as string[]) ?? [];
    expect(cookies.some((c) => c.startsWith("needy_rt="))).toBe(true);
  });

  /**
   * Every failure answers identically.
   *
   * An unknown number, a real account with no password, and a real account with the wrong
   * password must be indistinguishable. Anything else turns this route into a directory of who
   * holds an account — and on a platform whose users are selected for being vulnerable,
   * confirming that a number belongs to an elderly person living alone is itself the harm.
   */
  it("gives one undifferentiated answer to every kind of failure", async () => {
    await auth.setPassword("u-pw", GOOD);

    const unknownNumber = await login("+919000999999", GOOD);
    const noPasswordSet = await login(ADMIN_PHONE, GOOD);
    const wrongPassword = await login(USER_PHONE, "not the password");

    for (const res of [unknownNumber, noPasswordSet, wrongPassword]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "invalid-credentials" });
    }
  });

  /** A password proves nothing about a number nobody has claimed. `loginWithPhone` is
   *  find-or-create because a verified code proves the number; this path must never be. */
  it("never creates an account", async () => {
    const before = users.all().length;
    expect((await login("+919000888888", GOOD)).status).toBe(401);
    expect(users.all()).toHaveLength(before);
  });

  /** The caller is told nothing, so the signal is the only way a grind against one real
   *  account becomes visible to an operator. */
  it("records a signal against the account when a real one is guessed at", async () => {
    await auth.setPassword("u-pw", GOOD);
    await login(USER_PHONE, "wrong one");
    const signals = await abuse.listForSubject("u-pw", 0, 10);
    expect(signals.map((s) => s.kind)).toContain("auth.password_failed");
  });

  it("bounds attempts on one number", async () => {
    await auth.setPassword("u-pw", GOOD);
    let last = await login(USER_PHONE, "wrong");
    for (let i = 0; i < 6; i += 1) last = await login(USER_PHONE, "wrong");
    expect(last.status).toBe(429);
    // And the limiter is not a way to lock someone out of a correct password *forever* — it is
    // the same bucket, so this is simply refused for now rather than the password being wrong.
    expect(last.body.error).toBe("too-many-attempts");
  });

  // ── the admin second factor ────────────────────────────────────────────────

  /**
   * An admin sees every live emergency, both parties' phone numbers and every ID document. A
   * correct password gets them a code prompt, NOT a session.
   */
  it("refuses to hand an admin a session on the password alone", async () => {
    await auth.setPassword("u-admin", GOOD);
    const res = await login(ADMIN_PHONE, GOOD);

    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.pendingToken).toBeTruthy();
    expect(res.body.user).toBeUndefined();
    // The load-bearing assertion: no session cookie came back.
    const cookies = (res.headers["set-cookie"] as unknown as string[]) ?? [];
    expect(cookies.some((c) => c.startsWith("needy_rt="))).toBe(false);
  });

  it("completes the admin login once the code is entered too", async () => {
    await auth.setPassword("u-admin", GOOD);
    const first = await login(ADMIN_PHONE, GOOD);
    const res = await request(app)
      .post("/auth/password/mfa")
      .send({ phone: ADMIN_PHONE, code: CODE, pendingToken: first.body.pendingToken });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("admin");
    const cookies = (res.headers["set-cookie"] as unknown as string[]) ?? [];
    expect(cookies.some((c) => c.startsWith("needy_rt="))).toBe(true);
  });

  /**
   * Without the pending token this route would be a plain OTP login under another name, and
   * anyone able to receive the code could sign in as the admin having never known the password.
   */
  it("refuses the second factor without the token from the password step", async () => {
    await auth.setPassword("u-admin", GOOD);
    await login(ADMIN_PHONE, GOOD);

    const forged = await request(app)
      .post("/auth/password/mfa")
      .send({ phone: ADMIN_PHONE, code: CODE, pendingToken: "a".repeat(32) });
    expect(forged.status).toBe(401);
    expect(forged.body.error).toBe("mfa-expired");
  });

  it("consumes the pending token, so a completed login cannot be replayed", async () => {
    await auth.setPassword("u-admin", GOOD);
    const first = await login(ADMIN_PHONE, GOOD);
    const body = { phone: ADMIN_PHONE, code: CODE, pendingToken: first.body.pendingToken };

    expect((await request(app).post("/auth/password/mfa").send(body)).status).toBe(200);
    expect((await request(app).post("/auth/password/mfa").send(body)).status).toBe(401);
  });

  // ── managing your own password ─────────────────────────────────────────────

  it("requires the current password before replacing it", async () => {
    await auth.setPassword("u-pw", GOOD);
    const agent = request.agent(app);
    await agent.post("/auth/password/login").send({ phone: USER_PHONE, password: GOOD });

    const withoutCurrent = await agent
      .post("/auth/me/password")
      .send({ newPassword: "a whole new phrase" });
    expect(withoutCurrent.status).toBe(401);
    expect(withoutCurrent.body.error).toBe("current-password-invalid");

    const withCurrent = await agent
      .post("/auth/me/password")
      .send({ currentPassword: GOOD, newPassword: "a whole new phrase" });
    expect(withCurrent.status).toBe(200);
    expect(await verifyPassword("a whole new phrase", await users.getPasswordHash("u-pw"))).toBe(
      true,
    );
  });

  it("refuses a weak password with the reason", async () => {
    await auth.setPassword("u-pw", GOOD);
    const agent = request.agent(app);
    await agent.post("/auth/password/login").send({ phone: USER_PHONE, password: GOOD });

    const res = await agent
      .post("/auth/me/password")
      .send({ currentPassword: GOOD, newPassword: "short" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: "weak-password", problem: "too-short" });
  });

  /** The common reason to change a password is that someone else may have had it. Leaving
   *  their session alive would make the change cosmetic. */
  it("revokes other sessions on a password change but keeps the caller signed in", async () => {
    await auth.setPassword("u-pw", GOOD);
    const other = request.agent(app);
    await other.post("/auth/password/login").send({ phone: USER_PHONE, password: GOOD });
    expect((await other.get("/auth/me")).status).toBe(200);

    const changer = request.agent(app);
    await changer.post("/auth/password/login").send({ phone: USER_PHONE, password: GOOD });
    await changer
      .post("/auth/me/password")
      .send({ currentPassword: GOOD, newPassword: "another good phrase" });

    // The device that made the change is re-issued and still works.
    expect((await changer.get("/auth/me")).status).toBe(200);
    // The other device's refresh token is dead, which is what "revoked" has to mean.
    expect((await other.post("/auth/refresh")).status).toBe(401);
  });

  it("lets an account drop back to codes only", async () => {
    await auth.setPassword("u-pw", GOOD);
    const agent = request.agent(app);
    await agent.post("/auth/password/login").send({ phone: USER_PHONE, password: GOOD });

    expect((await agent.delete("/auth/me/password")).status).toBe(200);
    expect(await users.getPasswordHash("u-pw")).toBeNull();
    expect((await login(USER_PHONE, GOOD)).status).toBe(401);
  });

  /** The hash must never ride the user object out to a client — the lesson `handoffOtpHash`
   *  taught the hard way earlier. */
  it("never returns the hash from any user-facing endpoint", async () => {
    await auth.setPassword("u-pw", GOOD);
    const agent = request.agent(app);
    const login = await agent
      .post("/auth/password/login")
      .send({ phone: USER_PHONE, password: GOOD });
    const me = await agent.get("/auth/me");

    for (const body of [login.body.user, me.body.user]) {
      expect(JSON.stringify(body)).not.toContain("scrypt$");
      expect(body).not.toHaveProperty("passwordHash");
    }
  });
});
