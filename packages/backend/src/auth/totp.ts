import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { config } from "../config.js";

/** ── Authenticator-app codes (TOTP) ────────────────────────────────────────
 *  RFC 6238 over RFC 4226, from `node:crypto` and nothing else.
 *
 *  The same call this codebase made for password hashing and for Twilio: the algorithm is an
 *  HMAC and a truncation, about thirty lines, and a dependency on the one module that decides
 *  whether the strongest account on the platform is signed in is a supply-chain edge bought to
 *  save those thirty lines.
 *
 *  SHA-1, six digits, thirty seconds. Not because SHA-1 is a good hash — it is not — but
 *  because those are the only parameters every authenticator app actually honours. Several
 *  popular ones silently ignore `algorithm=SHA256` in the provisioning URI and generate SHA-1
 *  codes anyway, which presents as "the app works for everyone except this one operator".
 *  HMAC-SHA1 is not affected by SHA-1's collision weakness, so nothing is being traded away.
 */

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** One step either side of now. Wide enough for a phone clock that has drifted and for a code
 *  typed as it rolls over; every extra step is another code that is valid at any instant, so
 *  it is not wider than that. */
export const TOTP_WINDOW = 1;
/** 160 bits — the size of the HMAC-SHA1 block the RFC recommends, and what apps expect. */
const SECRET_BYTES = 20;

// ── base32 (RFC 4648, no padding) ────────────────────────────────────────────

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerant of what a person types from a screen: lower case, spaces, and trailing padding.
 *  Throws on anything that is not base32 at all, rather than decoding garbage into a key. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index === -1) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── the codes ────────────────────────────────────────────────────────────────

/** RFC 4226 §5.3: HMAC the counter as eight big-endian bytes, then dynamic truncation. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Which thirty-second step a moment falls in. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Check a code. Resolves the time-step it matched, or null.
 *
 * The STEP is returned rather than a boolean because the caller has a second job this function
 * cannot do: refusing a step it has already accepted. A code is valid for up to ninety seconds
 * and travels over a shoulder, a screen share and a phishing page in far less, so "is this
 * code right" is only half of the question — the other half is "has it been used", and that
 * needs the account's stored state.
 *
 * Every candidate in the window is computed and compared in constant time, with no early
 * exit, so how long this takes says nothing about which step (if any) came close.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number): number | null {
  if (!/^\d+$/.test(code) || code.length !== TOTP_DIGITS) return null;
  const presented = Buffer.from(code, "utf8");
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step), "utf8");
    // Ascending, so when two steps happen to share a code the LATER one is recorded and the
    // replay floor moves as far forward as it honestly can.
    if (timingSafeEqual(expected, presented)) matched = step;
  }
  return matched;
}

export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/**
 * The provisioning URI an authenticator app reads, by QR code or by link.
 *
 * It CONTAINS THE SECRET. It is returned exactly once, in the response to the request that
 * started enrolment, and is never logged and never stored in this form.
 */
export function otpauthUri(secret: Buffer, accountName: string): string {
  const issuer = "Needy";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── the secret at rest ───────────────────────────────────────────────────────

/**
 * A TOTP secret cannot be hashed.
 *
 * A password is checked by hashing what was typed and comparing; the server never needs the
 * password back. A TOTP secret is the opposite — the server must hold the very same key the
 * phone holds in order to compute the code — so the only protection available at rest is
 * encryption under a key the database does not contain. That is what this is: someone holding
 * a dump of `user_totp` and nothing else holds no second factors.
 *
 * AES-256-GCM, a fresh 96-bit nonce per encryption, and the account id as associated data.
 * The associated data is what stops a row being lifted: without it, anyone able to write to
 * the table could copy their OWN ciphertext over the super admin's and sign in with their own
 * phone. Bound to the id, a ciphertext moved to another row fails authentication.
 *
 * The key is derived with HKDF rather than used raw so the env value can be any long random
 * string (the same ≥32-character rule as the other secrets) and so this purpose has its own
 * key even if that string were ever reused somewhere it should not be.
 */
const FORMAT = "v1";
const encryptionKey = Buffer.from(
  hkdfSync("sha256", config.auth.totpEncryptionKey, Buffer.alloc(0), "needy/totp-secret/v1", 32),
);

export function encryptTotpSecret(secret: Buffer, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const sealed = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [FORMAT, iv, sealed, cipher.getAuthTag()]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/**
 * Null on anything that does not decrypt — a tampered row, a row moved from another account,
 * or a key that has changed. Never throws: the caller turns null into "that code is not
 * right", and an exception here would instead become a 500 that singles the account out.
 */
export function decryptTotpSecret(stored: string, userId: string): Buffer | null {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== FORMAT) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      Buffer.from(parts[1], "base64url"),
    );
    decipher.setAAD(Buffer.from(userId, "utf8"));
    decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]);
  } catch {
    return null;
  }
}

// ── recovery codes ───────────────────────────────────────────────────────────

export const RECOVERY_CODE_COUNT = 10;
/** No 0/O, 1/I/L — these are read off a printout and typed, possibly years later. */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RECOVERY_CODE_LENGTH = 12;

/**
 * Ten single-use codes for the day the phone is lost.
 *
 * Twelve characters from a 31-letter alphabet is about 59 bits each — far beyond guessing
 * through a rate-limited endpoint, and enough that an unsalted SHA-256 is an honest way to
 * store them: the slow, salted hash a password needs exists to protect LOW-entropy secrets
 * from an offline search, and there is no searching a 59-bit random space.
 */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let raw = "";
    for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
      raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
  });
}

/** Dashes, spaces and case are presentation; the hash is of the characters alone, so a code
 *  typed without its dashes or in capitals is still the same code. */
export function hashRecoveryCode(code: string): string {
  const canonical = code.replace(/[\s-]/g, "").toLowerCase();
  return createHash("sha256").update(canonical).digest("hex");
}
