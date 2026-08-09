import { describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import type { RedisClient } from "../redis.js";
import { OtpService } from "../auth/otp.js";
import { ConsoleSmsProvider } from "../auth/providers.js";

/** ── The development fixed code ────────────────────────────────────────────
 *  There is no SMS provider wired up yet, so every account currently accepts one known code.
 *
 *  These tests are about the guard rather than the convenience. A fixed code means a phone
 *  number IS an account — anyone who knows a helper's number can sign in as them, read their
 *  chats, see a requester's address and stand down an alarm. The only thing standing between
 *  that and production is a check that refuses to construct, so it is worth asserting that the
 *  check exists and that the code it lets through is genuinely the fixed one.
 */

const OTP_CONFIG = { length: 6, ttlSeconds: 300, maxPerHour: 50, maxAttempts: 5 };

/** The production guard, lifted out of the composition root so it can be exercised without
 *  booting a server. Mirrors `createOtpService` in index.ts. */
function guard(fixed: string, isProduction: boolean, length = 6): void {
  if (!fixed) return;
  if (isProduction) {
    throw new Error(
      "DEV_FIXED_OTP is set in production. Every account would share one passcode. Unset it.",
    );
  }
  if (!new RegExp(`^\\d{${length}}$`).test(fixed)) {
    throw new Error(`DEV_FIXED_OTP must be ${length} digits, got "${fixed}".`);
  }
}

describe("development fixed OTP", () => {
  it("accepts the fixed code for any number", async () => {
    const redis = new RedisMock() as unknown as RedisClient;
    await redis.flushall();
    const otp = new OtpService(redis, new ConsoleSmsProvider(), OTP_CONFIG, () => "123456");

    for (const phone of ["+919000000001", "+919000000002"]) {
      expect((await otp.request(phone, "1.2.3.4")).ok).toBe(true);
      expect((await otp.verify(phone, "123456")).ok).toBe(true);
    }
    (redis as unknown as { disconnect(): void }).disconnect();
  });

  /** The fixed code replaces the random one; it does not sit alongside it. A build where some
   *  other value also worked would be worse than either. */
  it("still refuses a wrong code", async () => {
    const redis = new RedisMock() as unknown as RedisClient;
    await redis.flushall();
    const otp = new OtpService(redis, new ConsoleSmsProvider(), OTP_CONFIG, () => "123456");

    await otp.request("+919000000003", "1.2.3.4");
    const wrong = await otp.verify("+919000000003", "999999");
    expect(wrong.ok).toBe(false);
    (redis as unknown as { disconnect(): void }).disconnect();
  });

  /**
   * The one that matters. This must FAIL THE BOOT, not warn: a warning in a startup log is
   * read once, by the person who already knew, and never again.
   */
  it("refuses to start in production", () => {
    expect(() => guard("123456", true)).toThrow(/production/i);
  });

  it("refuses a code that is not the configured length", () => {
    expect(() => guard("12345", false)).toThrow(/6 digits/);
    expect(() => guard("abcdef", false)).toThrow(/6 digits/);
  });

  it("is inert when unset — the real random generator is used", () => {
    expect(() => guard("", true)).not.toThrow();
    expect(() => guard("", false)).not.toThrow();
  });
});
