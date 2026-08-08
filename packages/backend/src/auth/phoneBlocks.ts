import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import type { DbPool } from "../db.js";

/** ── Phone blocklist ───────────────────────────────────────────────────────
 *  A rejected applicant is not merely denied — their number is blocked, so re-registering is
 *  not a way around the decision. This is the enforcement point: `loginWithPhone` consults it
 *  before it will find-or-create an account.
 *
 *  The number is stored as an HMAC, never in plaintext. Two reasons, and the second is the
 *  one that matters:
 *
 *   1. This table is a list of people the platform has refused. In a dump it would be a
 *      readable directory of exactly the users with the strongest claim to privacy.
 *   2. A plain SHA-256 would not help. Indian mobile numbers are ten digits with a handful of
 *      valid prefixes — well under 10^9 candidates, which is minutes of offline brute force on
 *      commodity hardware. An HMAC under a server-held key is not invertible without the key,
 *      so a stolen table alone yields nothing.
 *
 *  The key therefore has the same secrecy requirement as the JWT signing key. It is derived
 *  from the existing `config.jwtSecret` rather than adding a new required env var: rotating
 *  it invalidates the blocklist (blocked numbers would silently unblock), so it must be a
 *  value operators already treat as permanent. That coupling is deliberate and documented
 *  here so nobody rotates JWT_SECRET casually.
 */

const HMAC_DOMAIN = "needy:phone-block:v1";

/** Domain-separated so this digest can never collide with another HMAC built from the same
 *  key elsewhere in the app. */
export function phoneHmac(phoneE164: string): string {
  return createHmac("sha256", `${HMAC_DOMAIN}:${config.jwtSecret}`)
    .update(phoneE164.trim())
    .digest("hex");
}

/** Constant-time compare for the digests. Overkill for a hex string of fixed length, but the
 *  cost is nothing and the habit is what stops a timing oracle appearing the day someone
 *  reuses this helper somewhere it does matter. */
export function hmacEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface PhoneBlock {
  phoneHmac: string;
  reason: string;
  blockedBy: string | null;
  blockedAt: number;
}

export interface PhoneBlockRepository {
  /** True if this number may not hold an account. */
  isBlocked(phoneE164: string): Promise<boolean>;
  block(phoneE164: string, reason: string, blockedBy: string | null, at: number): Promise<void>;
  /** Reinstating someone. An explicit, audited admin action — never a user-triggered path. */
  unblock(phoneE164: string): Promise<void>;
}

export function createInMemoryPhoneBlockRepo(): PhoneBlockRepository {
  const blocks = new Map<string, PhoneBlock>();
  return {
    async isBlocked(phone) {
      return blocks.has(phoneHmac(phone));
    },
    async block(phone, reason, blockedBy, at) {
      const key = phoneHmac(phone);
      // First block wins: the original reason and timestamp are the evidence, and a later
      // re-block should not overwrite why the decision was originally made.
      if (!blocks.has(key)) blocks.set(key, { phoneHmac: key, reason, blockedBy, blockedAt: at });
    },
    async unblock(phone) {
      blocks.delete(phoneHmac(phone));
    },
  };
}

export function createPgPhoneBlockRepo(pool: DbPool): PhoneBlockRepository {
  return {
    async isBlocked(phone) {
      const { rows } = await pool.query<{ one: number }>(
        `SELECT 1 AS one FROM phone_blocks WHERE phone_hmac = $1`,
        [phoneHmac(phone)],
      );
      return rows.length > 0;
    },
    async block(phone, reason, blockedBy, at) {
      await pool.query(
        `INSERT INTO phone_blocks (phone_hmac, reason, blocked_by, blocked_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (phone_hmac) DO NOTHING`,
        [phoneHmac(phone), reason, blockedBy, at],
      );
    },
    async unblock(phone) {
      await pool.query(`DELETE FROM phone_blocks WHERE phone_hmac = $1`, [phoneHmac(phone)]);
    },
  };
}
