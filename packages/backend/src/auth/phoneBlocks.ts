import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import type { DbPool } from "../db.js";
import { phoneIndex } from "../crypto/pii.js";

/** ── Phone blocklist ───────────────────────────────────────────────────────
 *  A rejected applicant is not merely denied — their number is blocked, so re-registering is
 *  not a way around the decision. This is the enforcement point: `loginWithPhone` consults it
 *  before it will find-or-create an account.
 *
 *  The number is stored as a keyed digest, never in plaintext. Two reasons, and the second is
 *  the one that matters:
 *
 *   1. This table is a list of people the platform has refused. In a dump it would be a
 *      readable directory of exactly the users with the strongest claim to privacy.
 *   2. A plain SHA-256 would not help. Indian mobile numbers are ten digits with a handful of
 *      valid prefixes — well under 10^9 candidates, which is minutes of offline brute force on
 *      commodity hardware. An HMAC under a server-held key is not invertible without the key,
 *      so a stolen table alone yields nothing.
 *
 *  The digest is the same blind index `users.phone_hash` holds (crypto/pii.ts, under
 *  PII_INDEX_KEY). It used to be an HMAC keyed off `config.jwtSecret`, which coupled the
 *  blocklist to the signing key: rotating JWT_SECRET would have silently unblocked every
 *  refused number. Rows written under that old key are still honoured — see `legacyPhoneHmac`
 *  — and the boot-time backfill re-keys every one it can match to an account.
 */

/** The digest a block is stored under. Deterministic, so a lookup works at all; keyed, so the
 *  table cannot be reversed by enumerating numbers. */
export function phoneHmac(phoneE164: string): string {
  return phoneIndex(phoneE164);
}

const LEGACY_HMAC_DOMAIN = "needy:phone-block:v1";

/**
 * The digest blocks were stored under before migration 12: an HMAC keyed off the JWT secret.
 *
 * Still checked on every lookup, because a block whose number belongs to no account has no
 * plaintext anywhere for the backfill to re-key it from — and a refused number that quietly
 * stops being refused is the one failure this table exists to prevent. Never written.
 */
export function legacyPhoneHmac(phoneE164: string): string {
  return createHmac("sha256", `${LEGACY_HMAC_DOMAIN}:${config.jwtSecret}`)
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
      return blocks.has(phoneHmac(phone)) || blocks.has(legacyPhoneHmac(phone));
    },
    async block(phone, reason, blockedBy, at) {
      const key = phoneHmac(phone);
      // First block wins: the original reason and timestamp are the evidence, and a later
      // re-block should not overwrite why the decision was originally made.
      if (!blocks.has(key)) blocks.set(key, { phoneHmac: key, reason, blockedBy, blockedAt: at });
    },
    async unblock(phone) {
      blocks.delete(phoneHmac(phone));
      blocks.delete(legacyPhoneHmac(phone));
    },
  };
}

export function createPgPhoneBlockRepo(pool: DbPool): PhoneBlockRepository {
  return {
    async isBlocked(phone) {
      const { rows } = await pool.query<{ one: number }>(
        `SELECT 1 AS one FROM phone_blocks WHERE phone_hmac IN ($1, $2)`,
        [phoneHmac(phone), legacyPhoneHmac(phone)],
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
      // Both forms: reinstating someone must not leave a pre-migration block behind that
      // still refuses them.
      await pool.query(`DELETE FROM phone_blocks WHERE phone_hmac IN ($1, $2)`, [
        phoneHmac(phone),
        legacyPhoneHmac(phone),
      ]);
    },
  };
}
