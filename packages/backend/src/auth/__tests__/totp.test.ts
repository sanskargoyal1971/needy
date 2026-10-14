import { beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import RedisMock from "ioredis-mock";
import request, { type Response } from "supertest";
import type { RedisClient } from "../../redis.js";
import type { AuditEntry, AuditLogger } from "../../audit/log.js";
import {
  createInMemorySessionRepo,
  createInMemoryUserRepo,
  type InMemoryUserRepository,
} from "../repos.js";
import { createInMemoryKycDocumentRepo } from "../../onboarding/repos.js";
import { createInMemoryAbuseRepo } from "../../domain/abuseStore.js";
import { createInMemoryPhoneBlockRepo } from "../phoneBlocks.js";
import { AuthService } from "../service.js";
import { OtpService } from "../otp.js";
import { ConsoleSmsProvider, SandboxKycProvider } from "../providers.js";
import { createAuthRouter } from "../router.js";
import { createInMemoryTotpRepo, type TotpRepository } from "../totpRepo.js";
import {
  base32Decode,
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  otpauthUri,
  totpStep,
  verifyTotp,
} from "../totp.js";
import { makeUser } from "../types.js";
import { requireAuth, requireStaff } from "../middleware.js";

/** ── Authenticator-app second factor ───────────────────────────────────────
 *  Two halves. The first pins the algorithm to the RFCs' own published vectors, because a
 *  TOTP implementation that is subtly wrong still produces six plausible digits. The second
 *  drives the routes, and is mostly about what they REFUSE: a session on a password alone, a
 *  code used twice, a recovery code used twice, switching the factor off without it.
 */

const STEP_MS = 30_000;

describe("totp — the algorithm", () => {
  /** RFC 6238 Appendix B, the SHA-1 rows. The RFC prints eight digits; the last six of each
   *  are what a six-digit authenticator shows for the same moment. */
  const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
  const RFC_6238: Array<[seconds: number, eightDigits: string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(RFC_6238)("matches RFC 6238 at T=%i", (seconds, expected) => {
    const step = totpStep(seconds * 1000);
    expect(hotp(RFC_SECRET, step, 8)).toBe(expected);
    expect(hotp(RFC_SECRET, step)).toBe(expected.slice(-6));
    expect(verifyTotp(RFC_SECRET, expected.slice(-6), seconds * 1000)).toBe(step);
  });

  /** RFC 4226 Appendix D — the counter-based function underneath. */
  it("matches the RFC 4226 HOTP vectors", () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    expect(expected.map((_, counter) => hotp(RFC_SECRET, counter))).toEqual(expected);
  });

  it("encodes and decodes base32 as authenticator apps do", () => {
    // RFC 4648 §10, unpadded.
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(Buffer.from("fooba"))).toBe("MZXW6YTB");
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    // What a person actually types: lower case, grouped in fours.
    expect(base32Decode("mzxw 6ytb oi").toString()).toBe("foobar");
    expect(() => base32Decode("not!base32")).toThrow();
  });

  it("accepts one step either side of now and nothing further", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    for (const drift of [-1, 0, 1]) {
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + drift), now)).toBe(step + drift);
    }
    for (const drift of [-3, -2, 2, 3]) {
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + drift), now)).toBeNull();
    }
  });

  it("refuses anything that is not exactly six digits", () => {
    const now = 1_700_000_000_000;
    const good = hotp(RFC_SECRET, totpStep(now));
    expect(verifyTotp(RFC_SECRET, good.slice(0, 5), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, `${good}0`, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "", now)).toBeNull();
  });

  it("builds a provisioning URI an authenticator app can read", () => {
    const uri = new URL(otpauthUri(RFC_SECRET, "needy root"));
    expect(uri.protocol).toBe("otpauth:");
    expect(decodeURIComponent(uri.pathname)).toContain("Needy:needy root");
    expect(uri.searchParams.get("secret")).toBe(base32Encode(RFC_SECRET));
    expect(uri.searchParams.get("issuer")).toBe("Needy");
    expect(uri.searchParams.get("algorithm")).toBe("SHA1");
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(uri.searchParams.get("period")).toBe("30");
  });

  describe("the secret at rest", () => {
    it("round-trips, and stores nothing that looks like the secret", () => {
      const secret = generateTotpSecret();
      const stored = encryptTotpSecret(secret, "u-1");
      expect(decryptTotpSecret(stored, "u-1")?.equals(secret)).toBe(true);
      expect(stored).not.toContain(base32Encode(secret));
      expect(stored).not.toContain(secret.toString("hex"));
      expect(stored).not.toContain(secret.toString("base64url"));
    });

    /** A fresh nonce every time — otherwise two accounts sharing a secret (or one account
     *  re-enrolling) would be visible as identical ciphertexts. */
    it("never produces the same ciphertext twice", () => {
      const secret = generateTotpSecret();
      expect(encryptTotpSecret(secret, "u-1")).not.toBe(encryptTotpSecret(secret, "u-1"));
    });

    /**
     * The row cannot be lifted. Without the account id bound in, anyone able to write to the
     * table could copy their own ciphertext over the super admin's and sign in as them with
     * their own phone.
     */
    it("refuses a ciphertext moved to another account", () => {
      const stored = encryptTotpSecret(generateTotpSecret(), "u-attacker");
      expect(decryptTotpSecret(stored, "u-root")).toBeNull();
    });

    it("returns null, never throws, on a tampered or malformed value", () => {
      const stored = encryptTotpSecret(generateTotpSecret(), "u-1");
      const parts = stored.split(".");
      const flipped = Buffer.from(parts[2], "base64url");
      flipped[0] ^= 1;
      const tampered = [parts[0], parts[1], flipped.toString("base64url"), parts[3]].join(".");
      expect(decryptTotpSecret(tampered, "u-1")).toBeNull();
      expect(decryptTotpSecret("", "u-1")).toBeNull();
      expect(decryptTotpSecret("v1.a.b", "u-1")).toBeNull();
      expect(decryptTotpSecret("v9.a.b.c", "u-1")).toBeNull();
    });
  });

  it("generates ten distinct recovery codes, hashed without regard to dashes or case", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(hashRecoveryCode(codes[0].toUpperCase().replace(/-/g, " "))).toBe(
      hashRecoveryCode(codes[0]),
    );
    expect(hashRecoveryCode(codes[0])).not.toBe(hashRecoveryCode(codes[1]));
  });
});

// ── the routes ───────────────────────────────────────────────────────────────

const SMS_CODE = "123456";
const GOOD = "correct horse battery";
const ADMIN_PHONE = "+919876500202";
const ROOT = "needy-root";

describe("totp — staff sign-in", () => {
  let app: Express;
  let redis: RedisClient;
  let users: InMemoryUserRepository;
  let totp: TotpRepository;
  let auth: AuthService;
  let audited: AuditEntry[];
  let clock: number;

  /** Ten minutes: past every code window, and enough to refill every attempt bucket, so one
   *  phase of a test cannot starve the next of rate-limit tokens. */
  const later = () => {
    clock += 10 * 60_000;
  };
  const codeFor = (secretBase32: string, at = clock) =>
    hotp(base32Decode(secretBase32), totpStep(at));
  const hasSession = (res: Response) =>
    ((res.headers["set-cookie"] as unknown as string[]) ?? []).some((c) =>
      c.startsWith("needy_rt="),
    );
  /** The cookies a browser would send back, so a test can act as the signed-in person. */
  const cookieHeader = (res: Response) =>
    ((res.headers["set-cookie"] as unknown as string[]) ?? []).map((c) => c.split(";")[0]);

  beforeEach(async () => {
    redis = new RedisMock() as unknown as RedisClient;
    // ioredis-mock shares one keyspace across instances; see password.test.ts.
    await redis.flushall();
    users = createInMemoryUserRepo();
    totp = createInMemoryTotpRepo();
    audited = [];
    const audit: AuditLogger = {
      async record(entry) {
        audited.push(entry);
      },
    };
    clock = 1_700_000_000_000;
    const now = () => clock;
    auth = new AuthService({
      users,
      sessions: createInMemorySessionRepo(),
      phoneBlocks: createInMemoryPhoneBlockRepo(),
      totp,
      now,
    });

    await users.create(
      makeUser({
        id: "u-root",
        phone: "+990000000001",
        displayName: "Root",
        role: "super_admin",
        username: ROOT,
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
    await users.create(
      makeUser({
        id: "u-asha",
        phone: "+919876500203",
        displayName: "Asha",
        onboardingStatus: "approved",
      }),
    );
    for (const id of ["u-root", "u-admin", "u-asha"]) await auth.setPassword(id, GOOD);

    app = express();
    app.use(express.json());
    app.use(
      createAuthRouter({
        auth,
        otp: new OtpService(
          redis,
          new ConsoleSmsProvider(),
          { length: 6, ttlSeconds: 300, maxPerHour: 50, maxAttempts: 5 },
          () => SMS_CODE,
        ),
        kyc: new SandboxKycProvider(),
        users,
        totp,
        audit,
        documents: createInMemoryKycDocumentRepo(),
        redis,
        abuse: createInMemoryAbuseRepo(),
        now,
      }),
    );
    // Stands in for the admin console: guarded exactly as every admin route is.
    app.get("/staff-probe", requireAuth, requireStaff(users), (_req, res) => {
      res.json({ ok: true });
    });
  });

  const rootLogin = (password = GOOD) =>
    request(app).post("/auth/password/login").send({ username: ROOT, password });
  const adminLogin = () =>
    request(app).post("/auth/password/login").send({ phone: ADMIN_PHONE, password: GOOD });
  const totpLogin = (body: Record<string, unknown>) =>
    request(app).post("/auth/totp/login").send(body);
  /** Present a session's refresh token, as a browser does when its access token runs out. */
  const refreshWith = (cookies: string[]) =>
    request(app).post("/auth/refresh").set("Cookie", cookies).send();
  /** Reach a staff-only route with whatever access token these cookies carry. */
  const probeWith = (cookies: string[]) =>
    request(app).get("/staff-probe").set("Cookie", cookies).send();

  /** Walk the super admin through first-time enrolment. Leaves the clock ten minutes on, so
   *  whatever the test does next is in a fresh code window with fresh attempt budgets. */
  async function enrolRoot() {
    const first = await rootLogin();
    const pendingToken = first.body.pendingToken as string;
    const start = await request(app).post("/auth/totp/enrol/start").send({ pendingToken });
    const secret = start.body.secret as string;
    const confirm = await request(app)
      .post("/auth/totp/enrol/confirm")
      .send({ pendingToken, code: codeFor(secret) });
    later();
    return { pendingToken, secret, confirm, recoveryCodes: confirm.body.recoveryCodes as string[] };
  }

  // ── the gap this closes ────────────────────────────────────────────────────

  /**
   * The load-bearing test. Before this change a super admin's correct password returned
   * `{ user, csrfToken }` and set the session cookies: the account that can create operators
   * was one secret deep.
   */
  it("gives a super admin no session on the password alone", async () => {
    const res = await rootLogin();

    expect(res.status).toBe(200);
    expect(res.body.user).toBeUndefined();
    expect(res.body.csrfToken).toBeUndefined();
    expect(hasSession(res)).toBe(false);
    expect(res.headers["set-cookie"]).toBeUndefined();
    // Not enrolled yet, so what they are owed is enrolment — not a locked door.
    expect(res.body.enrolmentRequired).toBe(true);
    expect(res.body.pendingToken).toBeTruthy();
  });

  it("gives an enrolled super admin a code prompt, still with no session", async () => {
    await enrolRoot();
    const res = await rootLogin();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mfaRequired: true, method: "totp" });
    expect(res.body.enrolmentRequired).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    expect(hasSession(res)).toBe(false);
  });

  it("signs an enrolled super admin in once the code is entered too", async () => {
    const { secret } = await enrolRoot();
    const { pendingToken } = (await rootLogin()).body;
    const res = await totpLogin({ pendingToken, code: codeFor(secret) });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("super_admin");
    expect(res.body.csrfToken).toBeTruthy();
    expect(hasSession(res)).toBe(true);
  });

  /** Without the pending token this would be a login by authenticator alone — a code
   *  generator in place of a password rather than on top of one. */
  it("refuses a code without the token from the password step", async () => {
    const { secret } = await enrolRoot();
    await rootLogin();
    const res = await totpLogin({ pendingToken: "a".repeat(32), code: codeFor(secret) });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("mfa-expired");
    expect(hasSession(res)).toBe(false);
  });

  it("refuses a wrong code and leaves the password step standing", async () => {
    const { secret } = await enrolRoot();
    const { pendingToken } = (await rootLogin()).body;
    const good = codeFor(secret);
    const wrong = good === "000000" ? "000001" : "000000";

    const bad = await totpLogin({ pendingToken, code: wrong });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe("totp-invalid");
    expect(hasSession(bad)).toBe(false);

    // A mistyped code does not cost the operator their password step.
    expect((await totpLogin({ pendingToken, code: good })).status).toBe(200);
  });

  it("spends the pending token on success", async () => {
    const { secret } = await enrolRoot();
    const { pendingToken } = (await rootLogin()).body;
    expect((await totpLogin({ pendingToken, code: codeFor(secret) })).status).toBe(200);

    clock += STEP_MS;
    const again = await totpLogin({ pendingToken, code: codeFor(secret) });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("mfa-expired");
  });

  // ── replay ─────────────────────────────────────────────────────────────────

  /**
   * A code stays inside the window for up to ninety seconds, which is far longer than it
   * takes to read one over a shoulder or relay it through a phishing page. Used once, it is
   * dead — even to someone who also holds the password.
   */
  it("refuses a code that has already been accepted", async () => {
    const { secret } = await enrolRoot();
    const code = codeFor(secret);

    const first = await totpLogin({ pendingToken: (await rootLogin()).body.pendingToken, code });
    expect(first.status).toBe(200);

    const replay = await totpLogin({ pendingToken: (await rootLogin()).body.pendingToken, code });
    expect(replay.status).toBe(401);
    // Indistinguishable from a wrong code: "right, but already used" would confirm to a
    // thief that what they captured was real.
    expect(replay.body.error).toBe("totp-invalid");
    expect(hasSession(replay)).toBe(false);

    // The next step's code is a new code and works.
    clock += STEP_MS;
    const next = await totpLogin({
      pendingToken: (await rootLogin()).body.pendingToken,
      code: codeFor(secret),
    });
    expect(next.status).toBe(200);
  });

  it("refuses an earlier step once a later one has been accepted", async () => {
    const { secret } = await enrolRoot();
    const previous = codeFor(secret, clock - STEP_MS);
    const current = codeFor(secret);

    expect(
      (await totpLogin({ pendingToken: (await rootLogin()).body.pendingToken, code: current }))
        .status,
    ).toBe(200);
    // Inside the ±1 window on time alone, and refused because the floor has moved past it.
    const stale = await totpLogin({
      pendingToken: (await rootLogin()).body.pendingToken,
      code: previous,
    });
    expect(stale.status).toBe(401);
  });

  /** The code that proved enrolment is itself a used code. */
  it("does not let the enrolment code be turned around to sign in", async () => {
    const first = await rootLogin();
    const pendingToken = first.body.pendingToken as string;
    const start = await request(app).post("/auth/totp/enrol/start").send({ pendingToken });
    const code = codeFor(start.body.secret);
    await request(app).post("/auth/totp/enrol/confirm").send({ pendingToken, code });

    const res = await totpLogin({ pendingToken: (await rootLogin()).body.pendingToken, code });
    expect(res.status).toBe(401);
  });

  it("accepts the neighbouring step over the routes, and nothing further out", async () => {
    const { secret } = await enrolRoot();

    const drifted = await totpLogin({
      pendingToken: (await rootLogin()).body.pendingToken,
      code: codeFor(secret, clock - STEP_MS),
    });
    expect(drifted.status).toBe(200);

    later();
    for (const offset of [-2 * STEP_MS, 2 * STEP_MS]) {
      const res = await totpLogin({
        pendingToken: (await rootLogin()).body.pendingToken,
        code: codeFor(secret, clock + offset),
      });
      expect(res.status).toBe(401);
    }
  });

  it("bounds code attempts on one account", async () => {
    const { secret } = await enrolRoot();
    const { pendingToken } = (await rootLogin()).body;
    const good = codeFor(secret);
    const wrong = good === "000000" ? "000001" : "000000";

    let last = await totpLogin({ pendingToken, code: wrong });
    for (let i = 0; i < 6; i += 1) last = await totpLogin({ pendingToken, code: wrong });
    expect(last.status).toBe(429);
    expect(last.body.error).toBe("too-many-attempts");
    // And once the budget is gone, even the right code waits — otherwise the limiter would
    // only ever slow down the guesses that were going to fail anyway.
    expect((await totpLogin({ pendingToken, code: good })).status).toBe(429);
  });

  // ── bootstrap enrolment ────────────────────────────────────────────────────

  describe("first-time enrolment for a super admin", () => {
    it("issues the session only when a code confirms the app", async () => {
      const first = await rootLogin();
      const pendingToken = first.body.pendingToken as string;

      const start = await request(app).post("/auth/totp/enrol/start").send({ pendingToken });
      expect(start.status).toBe(200);
      expect(hasSession(start)).toBe(false);
      expect(start.headers["cache-control"]).toBe("no-store");
      expect(start.body.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(start.body.otpauthUri).toContain(`secret=${start.body.secret}`);
      // Generated, but not a second factor yet.
      expect((await totp.get("u-root"))?.status).toBe("pending");

      const confirm = await request(app)
        .post("/auth/totp/enrol/confirm")
        .send({ pendingToken, code: codeFor(start.body.secret) });
      expect(confirm.status).toBe(200);
      expect(confirm.body.user.role).toBe("super_admin");
      expect(confirm.body.csrfToken).toBeTruthy();
      expect(confirm.body.recoveryCodes).toHaveLength(10);
      expect(hasSession(confirm)).toBe(true);
      expect((await totp.get("u-root"))?.status).toBe("active");
      expect(audited.map((a) => a.action)).toContain("auth.totp_enrolled");
    });

    it("issues nothing for a wrong confirmation code", async () => {
      const { pendingToken } = (await rootLogin()).body;
      const start = await request(app).post("/auth/totp/enrol/start").send({ pendingToken });
      const good = codeFor(start.body.secret);

      const res = await request(app)
        .post("/auth/totp/enrol/confirm")
        .send({ pendingToken, code: good === "000000" ? "000001" : "000000" });
      expect(res.status).toBe(401);
      expect(res.body.recoveryCodes).toBeUndefined();
      expect(hasSession(res)).toBe(false);
      expect((await totp.get("u-root"))?.status).toBe("pending");
    });

    /** The enrolment token is a grant to enrol. It is not a session and not a second factor. */
    it("lets the enrolment token do nothing but enrol", async () => {
      const { pendingToken } = (await rootLogin()).body;

      const asLogin = await totpLogin({ pendingToken, code: "123456" });
      expect(asLogin.status).toBe(401);
      expect(hasSession(asLogin)).toBe(false);

      const asBearer = await request(app)
        .get("/auth/me")
        .set("Authorization", `Bearer ${pendingToken}`);
      expect(asBearer.status).toBe(401);
    });

    it("spends the enrolment token when enrolment completes", async () => {
      const { pendingToken } = await enrolRoot();
      const res = await request(app).post("/auth/totp/enrol/start").send({ pendingToken });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("enrolment-expired");
    });

    it("refuses to start enrolment with no token and no session", async () => {
      const res = await request(app).post("/auth/totp/enrol/start").send({});
      expect(res.status).toBe(401);
    });

    /** Otherwise a login token for an ENROLLED account would be a way to overwrite the
     *  authenticator knowing only the password. */
    it("does not let a sign-in token start an enrolment", async () => {
      await enrolRoot();
      const { pendingToken } = (await rootLogin()).body;
      const res = await request(app).post("/auth/totp/enrol/start").send({ pendingToken });
      expect(res.status).toBe(401);
      expect((await totp.get("u-root"))?.status).toBe("active");
    });

    it("stores the secret encrypted and never returns it again", async () => {
      const { secret, confirm } = await enrolRoot();
      const stored = await totp.get("u-root");
      expect(stored?.secretEnc).not.toContain(secret);
      expect(stored?.secretEnc.startsWith("v1.")).toBe(true);
      expect(JSON.stringify(confirm.body)).not.toContain(secret);

      const status = await request(app)
        .get("/auth/totp/status")
        .set("Cookie", cookieHeader(confirm));
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        available: true,
        required: true,
        enabled: true,
        recoveryCodesRemaining: 10,
      });
      expect(JSON.stringify(status.body)).not.toContain(secret);
      expect(JSON.stringify(status.body)).not.toContain(stored!.secretEnc);

      const me = await request(app).get("/auth/me").set("Cookie", cookieHeader(confirm));
      expect(JSON.stringify(me.body)).not.toContain(secret);
    });
  });

  // ── recovery codes ─────────────────────────────────────────────────────────

  it("accepts a recovery code exactly once, and writes it down", async () => {
    const { recoveryCodes } = await enrolRoot();

    const first = await totpLogin({
      pendingToken: (await rootLogin()).body.pendingToken,
      recoveryCode: recoveryCodes[0],
    });
    expect(first.status).toBe(200);
    expect(hasSession(first)).toBe(true);
    expect(first.body.recoveryCodesRemaining).toBe(9);
    const entry = audited.find((a) => a.action === "auth.totp_recovery_code_used");
    expect(entry).toMatchObject({ actorId: "u-root", subjectId: "u-root" });
    // The audit row says a code was spent. It must never say which.
    expect(JSON.stringify(entry)).not.toContain(recoveryCodes[0]);

    later();
    const second = await totpLogin({
      pendingToken: (await rootLogin()).body.pendingToken,
      recoveryCode: recoveryCodes[0],
    });
    expect(second.status).toBe(401);
    expect(hasSession(second)).toBe(false);

    // The other nine are untouched.
    const other = await totpLogin({
      pendingToken: (await rootLogin()).body.pendingToken,
      recoveryCode: recoveryCodes[1].toUpperCase(),
    });
    expect(other.status).toBe(200);
  });

  it("refuses a made-up recovery code, and a body carrying both kinds", async () => {
    const { secret, recoveryCodes } = await enrolRoot();
    const { pendingToken } = (await rootLogin()).body;

    const invented = await totpLogin({ pendingToken, recoveryCode: "aaaa-bbbb-cccc" });
    expect(invented.status).toBe(401);

    const both = await totpLogin({
      pendingToken,
      code: codeFor(secret),
      recoveryCode: recoveryCodes[0],
    });
    expect(both.status).toBe(400);
  });

  /**
   * The pending token is read, then the factor is checked, then the token is deleted. Two
   * requests racing on one token both pass the read, so the delete is the claim: only the
   * one that actually removed it may be signed in.
   */
  it("turns one pending token into one session, even raced with two good recovery codes", async () => {
    const { recoveryCodes } = await enrolRoot();
    const { pendingToken } = (await rootLogin()).body;

    // Hold each recovery-code check until both requests have reached it, so both have read
    // the pending token before either can delete it. Left to the scheduler the first request
    // usually finishes before the second starts, and the race this pins never happens.
    const consume = totp.consumeRecoveryCode.bind(totp);
    let arrived = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => (releaseBoth = resolve));
    totp.consumeRecoveryCode = async (...args) => {
      if (++arrived === 2) releaseBoth();
      await bothArrived;
      return consume(...args);
    };

    const results = await Promise.all([
      totpLogin({ pendingToken, recoveryCode: recoveryCodes[0] }),
      totpLogin({ pendingToken, recoveryCode: recoveryCodes[1] }),
    ]);

    expect(results.filter(hasSession)).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  // ── sessions from before the factor ────────────────────────────────────────

  /**
   * Before the authenticator existed a super admin's password alone returned a session, and
   * refresh rotation keeps such a session alive indefinitely. Enrolling has to end it, or the
   * second factor guards only the sign-ins that happen after it.
   */
  it("ends a session the password alone obtained, once the authenticator is enrolled", async () => {
    // Minted directly, the way the old password route did.
    const legacy = await auth.issueFor((await users.getById("u-root"))!, "before the change");

    const { confirm } = await enrolRoot();
    expect(hasSession(confirm)).toBe(true);

    const res = await refreshWith([`needy_rt=${legacy.refreshToken}`]);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("refresh-invalid");
  });

  /**
   * Enrolling is not the only way out of that state, and nobody has to enrol. Migration 10
   * ends such sessions at deploy, but the rule has to hold wherever a session is rotated: a
   * super admin with no active authenticator is a password-only account, and refresh used to
   * slide its session forward indefinitely.
   */
  it("will not rotate a super admin session while no authenticator is active", async () => {
    const legacy = await auth.issueFor((await users.getById("u-root"))!, "before the change");

    const res = await refreshWith([`needy_rt=${legacy.refreshToken}`]);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("refresh-invalid");
    // Cookies cleared, not rotated.
    expect(cookieHeader(res).sort()).toEqual(["needy_at=", "needy_rt="]);

    // A pending enrolment is not a factor either: the app has not proven it holds the secret.
    const another = await auth.issueFor((await users.getById("u-root"))!, "before the change");
    await totp.savePending("u-root", encryptTotpSecret(generateTotpSecret(), "u-root"), clock);
    expect((await refreshWith([`needy_rt=${another.refreshToken}`])).status).toBe(401);
  });

  it("still rotates an enrolled super admin's session", async () => {
    const { confirm } = await enrolRoot();
    expect((await refreshWith(cookieHeader(confirm))).status).toBe(200);
  });

  // ── disabling ──────────────────────────────────────────────────────────────

  describe("turning it off", () => {
    it("requires a current code, not just the session", async () => {
      const { secret, confirm } = await enrolRoot();
      const session = cookieHeader(confirm);
      const good = codeFor(secret);

      const none = await request(app).post("/auth/totp/disable").set("Cookie", session).send({});
      expect(none.status).toBe(400);

      const wrong = await request(app)
        .post("/auth/totp/disable")
        .set("Cookie", session)
        .send({ code: good === "000000" ? "000001" : "000000" });
      expect(wrong.status).toBe(401);
      expect((await totp.get("u-root"))?.status).toBe("active");
      expect(audited.map((a) => a.action)).not.toContain("auth.totp_disabled");

      const ok = await request(app)
        .post("/auth/totp/disable")
        .set("Cookie", session)
        .send({ code: good });
      expect(ok.status).toBe(200);
      expect(await totp.get("u-root")).toBeNull();
      expect(audited.map((a) => a.action)).toContain("auth.totp_disabled");
    });

    /**
     * A super admin has no other second factor, so the moment theirs is removed every session
     * on the account is one no second factor stands behind — including the one doing the
     * removing. Handing that device a fresh session would leave the account single-factor
     * for as long as it kept refreshing. Everything ends; the next sign-in is enrolment.
     */
    it("signs a super admin out everywhere, the device doing it included", async () => {
      const { secret, confirm } = await enrolRoot();
      const elsewhere = await totpLogin({
        pendingToken: (await rootLogin()).body.pendingToken,
        code: codeFor(secret),
      });
      expect(hasSession(elsewhere)).toBe(true);
      expect((await probeWith(cookieHeader(confirm))).status).toBe(200);

      clock += STEP_MS;
      const off = await request(app)
        .post("/auth/totp/disable")
        .set("Cookie", cookieHeader(confirm))
        .send({ code: codeFor(secret) });
      expect(off.status).toBe(200);
      expect(off.body).toEqual({ ok: true, signedOut: true });
      // Both cookies cleared, none re-issued.
      expect(cookieHeader(off).sort()).toEqual(["needy_at=", "needy_rt="]);

      // Neither the access token it held nor the one on the other device opens the console,
      // although both are well inside their lifetime ...
      expect((await probeWith(cookieHeader(confirm))).status).toBe(401);
      expect((await probeWith(cookieHeader(elsewhere))).status).toBe(401);
      // ... and neither refresh token buys a new one.
      expect((await refreshWith(cookieHeader(elsewhere))).status).toBe(401);
      expect((await refreshWith(cookieHeader(confirm))).status).toBe(401);
    });

    it("refuses without a session at all", async () => {
      const { secret } = await enrolRoot();
      const res = await request(app)
        .post("/auth/totp/disable")
        .send({ code: codeFor(secret) });
      expect(res.status).toBe(401);
      expect((await totp.get("u-root"))?.status).toBe("active");
    });

    /** A recovery code gets you IN when the phone is lost. It is not the phone. */
    it("does not accept a recovery code in place of the authenticator", async () => {
      const { confirm, recoveryCodes } = await enrolRoot();
      const res = await request(app)
        .post("/auth/totp/disable")
        .set("Cookie", cookieHeader(confirm))
        .send({ code: recoveryCodes[0] });
      expect(res.status).toBe(400);
      expect((await totp.get("u-root"))?.status).toBe("active");
    });

    /** Disabling must not be a route back to the old behaviour. */
    it("leaves a super admin owing enrolment, never single-factor", async () => {
      const { secret, confirm, recoveryCodes } = await enrolRoot();
      await request(app)
        .post("/auth/totp/disable")
        .set("Cookie", cookieHeader(confirm))
        .send({ code: codeFor(secret) });
      later();

      const res = await rootLogin();
      expect(res.body.enrolmentRequired).toBe(true);
      expect(res.body.user).toBeUndefined();
      expect(hasSession(res)).toBe(false);

      // And the old recovery codes went with the old authenticator.
      expect(recoveryCodes).toHaveLength(10);
      expect(await totp.recoveryCodesRemaining("u-root")).toBe(0);
    });
  });

  // ── admins ─────────────────────────────────────────────────────────────────

  describe("an ordinary admin", () => {
    const adminSession = async () => {
      const first = await adminLogin();
      const res = await request(app).post("/auth/password/mfa").send({
        phone: ADMIN_PHONE,
        code: SMS_CODE,
        pendingToken: first.body.pendingToken,
      });
      return cookieHeader(res);
    };

    async function enrolAdmin() {
      const session = await adminSession();
      const start = await request(app)
        .post("/auth/totp/enrol/start")
        .set("Cookie", session)
        .send({ password: GOOD });
      const confirm = await request(app)
        .post("/auth/totp/enrol/confirm")
        .set("Cookie", session)
        .send({ code: codeFor(start.body.secret) });
      later();
      return { session, secret: start.body.secret as string, confirm };
    }

    it("still gets a text-message code until they enrol an authenticator", async () => {
      const res = await adminLogin();
      expect(res.body).toMatchObject({ mfaRequired: true, method: "sms" });
      expect(hasSession(res)).toBe(false);
    });

    /** A session is a cookie on a machine. Without the password, anyone who sat down at an
     *  unlocked console could bind the operator's account to their own phone. */
    it("must re-enter the password to start enrolling from a session", async () => {
      const session = await adminSession();

      const none = await request(app)
        .post("/auth/totp/enrol/start")
        .set("Cookie", session)
        .send({});
      expect(none.status).toBe(401);
      expect(none.body.error).toBe("current-password-invalid");

      const wrong = await request(app)
        .post("/auth/totp/enrol/start")
        .set("Cookie", session)
        .send({ password: "not the password" });
      expect(wrong.status).toBe(401);
      expect(await totp.get("u-admin")).toBeNull();
    });

    it("enrols from a session and gets recovery codes and one fresh session", async () => {
      const { session, confirm } = await enrolAdmin();
      expect(confirm.status).toBe(200);
      expect(confirm.body.recoveryCodes).toHaveLength(10);
      expect(confirm.body.user).toBeUndefined();
      // The enrolling device's session is replaced, not added to: the one it had was obtained
      // without the authenticator, and is now refused.
      // (New first: presenting a revoked token past the grace window ends every session, by
      // the reuse rule, which would take the new one down with it.)
      expect(hasSession(confirm)).toBe(true);
      expect((await refreshWith(cookieHeader(confirm))).status).toBe(200);
      expect((await refreshWith(session)).status).toBe(401);
      expect(audited.find((a) => a.action === "auth.totp_enrolled")).toMatchObject({
        actorId: "u-admin",
        metadata: { via: "session" },
      });
    });

    /** "Replaces", not "adds". With both doors open the account is as strong as the weaker
     *  one, and the weaker one is a SIM swap. */
    it("uses the authenticator INSTEAD of the text message once enrolled", async () => {
      const session = await adminSession();
      const start = await request(app)
        .post("/auth/totp/enrol/start")
        .set("Cookie", session)
        .send({ password: GOOD });
      // A text-message step left half-finished from just BEFORE enrolling — what someone
      // holding the password and the SIM would have ready.
      const stale = await adminLogin();
      expect(stale.body.method).toBe("sms");
      await request(app)
        .post("/auth/totp/enrol/confirm")
        .set("Cookie", session)
        .send({ code: codeFor(start.body.secret) });

      const viaStaleSms = await request(app)
        .post("/auth/password/mfa")
        .send({ phone: ADMIN_PHONE, code: SMS_CODE, pendingToken: stale.body.pendingToken });
      expect(viaStaleSms.status).toBe(401);
      expect(hasSession(viaStaleSms)).toBe(false);

      later();
      const res = await adminLogin();
      expect(res.body).toMatchObject({ mfaRequired: true, method: "totp" });
      // The authenticator token is not a text-message token either.
      const viaSms = await request(app)
        .post("/auth/password/mfa")
        .send({ phone: ADMIN_PHONE, code: SMS_CODE, pendingToken: res.body.pendingToken });
      expect(viaSms.status).toBe(401);
      expect(hasSession(viaSms)).toBe(false);

      const viaApp = await totpLogin({
        pendingToken: res.body.pendingToken,
        code: codeFor(start.body.secret),
      });
      expect(viaApp.status).toBe(200);
      expect(viaApp.body.user.role).toBe("admin");
    });

    /**
     * An admin falls back to the text message, so they keep the device they disabled from.
     * Every other device loses the console at once — its refresh token AND the access token
     * it already holds, which used to stay good for up to its fifteen-minute lifetime: long
     * enough for whoever has the lost phone to read the verification queue.
     */
    it("on disabling, keeps this device and shuts every other out at once", async () => {
      const { secret, confirm } = await enrolAdmin();
      const first = await adminLogin();
      const elsewhere = await totpLogin({
        pendingToken: first.body.pendingToken,
        code: codeFor(secret),
      });
      expect((await probeWith(cookieHeader(elsewhere))).status).toBe(200);

      clock += STEP_MS;
      const off = await request(app)
        .post("/auth/totp/disable")
        .set("Cookie", cookieHeader(confirm))
        .send({ code: codeFor(secret) });
      expect(off.status).toBe(200);
      expect(off.body).toEqual({ ok: true });
      expect(hasSession(off)).toBe(true);

      expect((await probeWith(cookieHeader(off))).status).toBe(200);
      expect((await probeWith(cookieHeader(elsewhere))).status).toBe(401);
      expect((await refreshWith(cookieHeader(off))).status).toBe(200);
      expect((await refreshWith(cookieHeader(elsewhere))).status).toBe(401);
    });

    /** Enrolling ends the other devices' sessions too, and their access tokens with them. */
    it("on enrolling, shuts the other devices' access tokens out as well", async () => {
      const elsewhere = await adminSession();
      expect((await probeWith(elsewhere)).status).toBe(200);
      const { confirm } = await enrolAdmin();

      expect((await probeWith(cookieHeader(confirm))).status).toBe(200);
      expect((await probeWith(elsewhere)).status).toBe(401);
    });

    /** A password change already ended the other sessions; it now ends their access too. */
    it("on a password change, shuts the other devices' access tokens out", async () => {
      const elsewhere = await adminSession();
      const here = await adminSession();
      const changed = await request(app)
        .post("/auth/me/password")
        .set("Cookie", here)
        .send({ currentPassword: GOOD, newPassword: "a different long passphrase" });
      expect(changed.status).toBe(200);

      expect((await probeWith(cookieHeader(changed))).status).toBe(200);
      expect((await probeWith(elsewhere)).status).toBe(401);
    });

    it("cannot replace a working authenticator by enrolling again", async () => {
      // The session enrolling issued: the one it started from was ended by it.
      const { confirm } = await enrolAdmin();
      const before = (await totp.get("u-admin"))?.secretEnc;
      const res = await request(app)
        .post("/auth/totp/enrol/start")
        .set("Cookie", cookieHeader(confirm))
        .send({ password: GOOD });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("totp-already-enabled");
      expect((await totp.get("u-admin"))?.secretEnc).toBe(before);
    });

    it("stops a deactivated operator finishing a sign-in they had already started", async () => {
      const { secret } = await enrolAdmin();
      const { pendingToken } = (await adminLogin()).body;
      await users.update("u-admin", { blockedAt: clock });

      const res = await totpLogin({ pendingToken, code: codeFor(secret) });
      expect(res.status).toBe(401);
      expect(hasSession(res)).toBe(false);
    });
  });

  it("is not offered to someone who is not staff", async () => {
    const login = await request(app)
      .post("/auth/password/login")
      .send({ phone: "+919876500203", password: GOOD });
    // An ordinary account is untouched by all of this: password in, session out.
    expect(hasSession(login)).toBe(true);
    const session = cookieHeader(login);

    const start = await request(app)
      .post("/auth/totp/enrol/start")
      .set("Cookie", session)
      .send({ password: GOOD });
    expect(start.status).toBe(403);
    expect(await totp.get("u-asha")).toBeNull();

    const status = await request(app).get("/auth/totp/status").set("Cookie", session);
    expect(status.body).toMatchObject({ available: false, required: false, enabled: false });
  });
});
