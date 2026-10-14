import RedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";
import { createPiiCipher, phoneIndex, PiiDecryptError } from "../pii.js";
import { OtpService } from "../../auth/otp.js";
import { ConsoleSmsProvider } from "../../auth/providers.js";
import { keys } from "../../domain/keys.js";
import type { RedisClient } from "../../redis.js";

/** ── The personal-data envelope and blind index ────────────────────────────
 *  Pure unit tests: no database. The Postgres side — what actually lands in `users` — is in
 *  auth/__tests__/pgUserPii.test.ts.
 */

const OLD = "old-key-".padEnd(40, "o");
const NEW = "new-key-".padEnd(40, "n");
const INDEX = "index-key-".padEnd(40, "i");

const cipherOld = createPiiCipher({ currentKey: OLD, previousKeys: [], indexKey: INDEX });
const cipherRotated = createPiiCipher({ currentKey: NEW, previousKeys: [OLD], indexKey: INDEX });
const cipherNewOnly = createPiiCipher({ currentKey: NEW, previousKeys: [], indexKey: INDEX });

const CTX = "users.phone:u1";
const PHONE = "+919876543210";

/** Swap one base64url character for another in segment `i`, which always changes the bytes. */
function corrupt(stored: string, i: number): string {
  const parts = stored.split(".");
  const seg = parts[i];
  parts[i] = (seg[0] === "A" ? "B" : "A") + seg.slice(1);
  return parts.join(".");
}

describe("pii envelope", () => {
  it("round-trips, and the ciphertext does not contain the value", () => {
    const sealed = cipherOld.encrypt(PHONE, CTX);
    expect(sealed).not.toContain("9876543210");
    expect(cipherOld.decrypt(sealed, CTX)).toBe(PHONE);
  });

  it("is randomised: the same value sealed twice gives two different ciphertexts", () => {
    expect(cipherOld.encrypt(PHONE, CTX)).not.toBe(cipherOld.encrypt(PHONE, CTX));
  });

  it("names the key it was sealed under", () => {
    const sealed = cipherOld.encrypt(PHONE, CTX);
    expect(cipherOld.keyIdOf(sealed)).toBe(cipherOld.currentKeyId);
    expect(sealed.split(".")[1]).toBe(cipherOld.currentKeyId);
    expect(cipherOld.keyIdOf("not an envelope")).toBeNull();
  });

  it("refuses a tampered nonce, ciphertext or tag", () => {
    const sealed = cipherOld.encrypt(PHONE, CTX);
    for (const segment of [2, 3, 4]) {
      expect(() => cipherOld.decrypt(corrupt(sealed, segment), CTX)).toThrow(PiiDecryptError);
    }
  });

  /** GCM accepts a truncated tag unless told otherwise, and the stored value carries its own
   *  tag — so without a pinned length, whoever writes the row picks how many bits of integrity
   *  it has. A genuine tag cut to its first four bytes is a valid 32-bit GCM tag, and opened
   *  before the length was pinned. */
  it("refuses a truncated tag, even one that is a genuine prefix", () => {
    const sealed = cipherOld.encrypt(PHONE, CTX);
    const parts = sealed.split(".");
    const tag = Buffer.from(parts[4], "base64url");
    expect(tag).toHaveLength(16);
    for (const len of [4, 8, 12, 15]) {
      const cut = [...parts.slice(0, 4), tag.subarray(0, len).toString("base64url")].join(".");
      expect(() => cipherOld.decrypt(cut, CTX)).toThrow(PiiDecryptError);
    }
    // And a nonce of the wrong length is a format error, not something to try.
    const shortIv = [parts[0], parts[1], "AAAA", parts[3], parts[4]].join(".");
    expect(() => cipherOld.decrypt(shortIv, CTX)).toThrow(/unknown format/);
  });

  /** The associated data: a ciphertext lifted onto another row, or into another column, must
   *  not open — otherwise writing your own sealed number onto someone else's row would send
   *  their one-time codes to you. */
  it("refuses a ciphertext moved to another row or column", () => {
    const sealed = cipherOld.encrypt(PHONE, CTX);
    expect(() => cipherOld.decrypt(sealed, "users.phone:u2")).toThrow(PiiDecryptError);
    expect(() => cipherOld.decrypt(sealed, "users.date_of_birth:u1")).toThrow(PiiDecryptError);
  });

  it("refuses an unknown key id or format, without echoing the value", () => {
    const sealed = cipherOld.encrypt(PHONE, CTX);
    const parts = sealed.split(".");
    parts[1] = "00000000";
    let message = "";
    try {
      cipherOld.decrypt(parts.join("."), CTX);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/no configured key/);
    expect(message).not.toContain("u1");
    expect(() => cipherOld.decrypt(`v9${sealed.slice(2)}`, CTX)).toThrow(PiiDecryptError);
    expect(() => cipherOld.decrypt(PHONE, CTX)).toThrow(PiiDecryptError);
  });

  describe("key rotation", () => {
    it("still opens values sealed under the previous key", () => {
      const sealedOld = cipherOld.encrypt(PHONE, CTX);
      expect(cipherRotated.decrypt(sealedOld, CTX)).toBe(PHONE);
    });

    it("seals new values under the new key only", () => {
      const sealedNew = cipherRotated.encrypt(PHONE, CTX);
      expect(cipherRotated.keyIdOf(sealedNew)).toBe(cipherNewOnly.currentKeyId);
      expect(cipherRotated.keyIdOf(sealedNew)).not.toBe(cipherOld.currentKeyId);
      // So once everything is re-sealed, the old key can be removed…
      expect(cipherNewOnly.decrypt(sealedNew, CTX)).toBe(PHONE);
      // …and a value only the old key opens is refused once it is gone, loudly.
      expect(() => cipherNewOnly.decrypt(cipherOld.encrypt(PHONE, CTX), CTX)).toThrow(
        /no configured key/,
      );
    });
  });
});

describe("blind index", () => {
  it("is deterministic and does not contain the value", () => {
    const a = phoneIndex(PHONE, cipherOld);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("9876543210");
    expect(phoneIndex(PHONE, cipherOld)).toBe(a);
    // Trimmed, exactly like phoneSchema trims, so a padded number finds the same account.
    expect(phoneIndex(`  ${PHONE} `, cipherOld)).toBe(a);
    expect(phoneIndex("+919876543211", cipherOld)).not.toBe(a);
  });

  /** It depends on the index key and on nothing that rotates: rotating the encryption key
   *  must not make every existing number unfindable. */
  it("is unaffected by rotating the encryption key, and changes with the index key", () => {
    expect(phoneIndex(PHONE, cipherRotated)).toBe(phoneIndex(PHONE, cipherOld));
    const otherIndex = createPiiCipher({ currentKey: OLD, previousKeys: [], indexKey: NEW });
    expect(phoneIndex(PHONE, otherIndex)).not.toBe(phoneIndex(PHONE, cipherOld));
  });

  it("separates purposes", () => {
    expect(cipherOld.blindIndex("phone", PHONE)).not.toBe(cipherOld.blindIndex("email", PHONE));
  });
});

/** Redis key names are visible to SCAN, MONITOR, the slow log and every RDB dump. */
describe("redis keys never carry a raw phone number", () => {
  it("names the OTP and second-factor keys by the blind index", async () => {
    const redis = new RedisMock() as unknown as RedisClient;
    await redis.flushall();
    const otp = new OtpService(
      redis,
      new ConsoleSmsProvider(),
      { length: 6, ttlSeconds: 300, maxPerHour: 5, maxAttempts: 5 },
      () => "123456",
    );
    expect((await otp.request(PHONE, "203.0.113.9")).ok).toBe(true);
    await otp.verify(PHONE, "000000");
    const names = await redis.keys("*");
    expect(names.some((k) => k.startsWith("otp:code:"))).toBe(true);
    expect(names.some((k) => k.startsWith("otp:attempts:"))).toBe(true);
    for (const k of names) expect(k).not.toContain("9876543210");

    expect(keys.mfaPending(PHONE)).not.toContain("9876543210");
    expect(keys.mfaPending(PHONE)).toBe(keys.mfaPending(` ${PHONE}`));

    // And the flow still works end to end under the new names.
    expect(await otp.verify(PHONE, "123456")).toEqual({ ok: true });
  });
});
