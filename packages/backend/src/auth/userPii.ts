import type pg from "pg";
import type { DbPool } from "../db.js";
import type { MigrationLog } from "../migrations.js";
import { legacyPhoneHmac } from "./phoneBlocks.js";
import { phoneIndex, pii, type PiiCipher } from "../crypto/pii.js";

/** ── The sealed columns of `users` ─────────────────────────────────────────
 *  The phone number and date of birth are encrypted by the repository, and only there (see
 *  migration 12 and crypto/pii.ts). Everything above the repository still sees a `User` with
 *  both in plaintext; nothing else in the app had to learn that they are sealed at rest.
 *
 *  These helpers are the single mapping between the two forms, shared by the user repository
 *  and the boot-time backfill, so the backfill cannot seal a row in a way the repository then
 *  fails to open.
 */

/** Associated data for each sealed column. Binding the row id and the column name means a
 *  ciphertext copied onto another account, or from one column to another, does not open. */
export const phoneContext = (userId: string) => `users.phone:${userId}`;
export const dobContext = (userId: string) => `users.date_of_birth:${userId}`;
/** A helper application keeps its own copy of the applicant's number (migration 13). Its own
 *  table and column in the context, so a sealed number cannot be moved between an application
 *  and an account either. */
export const applicationPhoneContext = (applicationId: string) =>
  `helper_applications.phone:${applicationId}`;

export interface SealedPhone {
  phone_enc: string;
  phone_hash: string;
  phone_last4: string;
}

export function sealPhone(userId: string, phone: string, cipher: PiiCipher = pii): SealedPhone {
  const trimmed = phone.trim();
  return {
    phone_enc: cipher.encrypt(trimmed, phoneContext(userId)),
    phone_hash: phoneIndex(trimmed, cipher),
    phone_last4: trimmed.replace(/\D/g, "").slice(-4),
  };
}

export function sealDob(userId: string, dob: string | null, cipher: PiiCipher = pii) {
  return dob == null ? null : cipher.encrypt(dob, dobContext(userId));
}

/**
 * The plaintext phone for a row: the sealed column when there is one, otherwise the legacy
 * plaintext column — a row the backfill has not reached yet, or one inserted by hand.
 * Throws when a sealed value does not open (see `PiiCipher.decrypt` for why that is loud).
 */
export function openPhone(
  r: { id: string; phone?: string | null; phone_enc?: string | null },
  cipher: PiiCipher = pii,
): string {
  if (r.phone_enc) return cipher.decrypt(r.phone_enc, phoneContext(r.id));
  if (r.phone != null) return r.phone;
  throw new Error(`user ${r.id} has no phone in either form`);
}

export function sealApplicationPhone(
  applicationId: string,
  phone: string,
  cipher: PiiCipher = pii,
): string {
  return cipher.encrypt(phone.trim(), applicationPhoneContext(applicationId));
}

/** The same fallback as `openPhone`, for a helper application's copy of the number. */
export function openApplicationPhone(
  r: { id: string; phone?: string | null; phone_enc?: string | null },
  cipher: PiiCipher = pii,
): string {
  if (r.phone_enc) return cipher.decrypt(r.phone_enc, applicationPhoneContext(r.id));
  if (r.phone != null) return r.phone;
  throw new Error(`application ${r.id} has no phone in either form`);
}

export function openDob(
  r: { id: string; date_of_birth_enc?: string | null },
  plaintext: string | null,
  cipher: PiiCipher = pii,
): string | null {
  if (r.date_of_birth_enc) return cipher.decrypt(r.date_of_birth_enc, dobContext(r.id));
  return plaintext;
}

// ── backfill ─────────────────────────────────────────────────────────────────

/** Its own advisory lock, distinct from the migration runner's, so a backfill in progress does
 *  not hold up a later boot's migrations and vice versa. Fixed for the same reason that one is:
 *  the number is the identity of the lock. */
const BACKFILL_LOCK_KEY = 0x6e706969; // "npii"

export interface BackfillResult {
  /** `users` rows sealed and emptied by this run. */
  sealed: number;
  /** Rows left holding plaintext because sealing them would duplicate another account's
   *  number. Each is logged by id; an operator has to decide which account is real. */
  conflicts: number;
  /** Rows (in either table) that something else rewrote between this run reading them and
   *  sealing them. Left alone rather than overwritten with the stale value; the next boot
   *  seals whatever they hold then. */
  deferred: number;
  /** `helper_applications` rows sealed and emptied by this run. */
  applicationsSealed: number;
}

type Client = pg.PoolClient;

/**
 * Seal every row that still holds a plaintext phone or date of birth, then empty those columns:
 * `users` (migration 12) and the copy of the number each helper application keeps (13).
 *
 * Runs at boot, after `migrate`. Static SQL in a migration cannot do this — the key is not in
 * the database — so it is a step of its own, with the same guarantees the migration runner has:
 *
 *  - **Advisory-locked.** Two instances booting together give one backfiller and one waiter
 *    that then finds nothing left to do. Session-level, on a dedicated connection, so it is
 *    released if the process dies mid-run.
 *  - **Idempotent.** It selects only rows that still hold plaintext, and a sealed row holds
 *    none, so a re-run is a single empty query.
 *  - **Batched.** Each batch commits on its own, so a large table is not one long transaction,
 *    and a crash part-way keeps the batches already done. Keyset-paged by id, so a row skipped
 *    for a conflict is passed over rather than reselected for ever.
 *  - **Compare-and-set.** A batch is read before its transaction and holds no row locks, and
 *    the rollout this runs during is exactly when an older build may still be writing rows. So
 *    every UPDATE is conditional on the row still holding the plaintext that was read: a row
 *    changed in between is left alone and counted as deferred, rather than having its newer
 *    number or date of birth silently replaced by the one read a moment earlier.
 *
 * A row with plaintext is re-sealed FROM the plaintext even if it already has ciphertext: the
 * only way to have both is an older build writing the row after it was sealed, which makes the
 * plaintext the newer value.
 *
 * The phone blocklist used to be keyed by an HMAC under the JWT secret. While each number is
 * in hand, its block (if any) is re-keyed to the blind index — the last moment the plaintext
 * needed to do that exists.
 */
export async function backfillUserPii(
  pool: DbPool,
  log: MigrationLog,
  opts: { cipher?: PiiCipher; batchSize?: number } = {},
): Promise<BackfillResult> {
  const cipher = opts.cipher ?? pii;
  const batchSize = opts.batchSize ?? 200;
  const client = await pool.connect();
  const result: BackfillResult = { sealed: 0, conflicts: 0, deferred: 0, applicationsSealed: 0 };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [BACKFILL_LOCK_KEY]);
    try {
      await sealUsers(client, log, cipher, batchSize, result);
      await sealApplications(client, cipher, batchSize, result);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [BACKFILL_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  if (Object.values(result).some((n) => n > 0)) {
    log.info("sealed personal data at rest", { ...result });
  }
  if (result.deferred > 0) {
    log.warn("rows changed while being sealed were left for the next boot", {
      deferred: result.deferred,
    });
  }
  return result;
}

/** Runs `body` in a transaction, rolling back if it throws. */
async function inTransaction(client: Client, body: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await body();
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

async function sealUsers(
  client: Client,
  log: MigrationLog,
  cipher: PiiCipher,
  batchSize: number,
  result: BackfillResult,
): Promise<void> {
  let after = "";
  for (;;) {
    // `to_char` rather than the DATE itself: `pg` turns a DATE into a JS Date at local
    // midnight, and the day it reports depends on the server's time zone.
    const { rows } = await client.query<{
      id: string;
      phone: string | null;
      dob: string | null;
    }>(
      `SELECT id, phone, to_char(date_of_birth, 'YYYY-MM-DD') AS dob
         FROM users
        WHERE (phone IS NOT NULL OR date_of_birth IS NOT NULL) AND id > $1
        ORDER BY id
        LIMIT $2`,
      [after, batchSize],
    );
    if (rows.length === 0) return;
    after = rows[rows.length - 1].id;

    await inTransaction(client, async () => {
      for (const r of rows) {
        // The date first: it cannot conflict with anything, so a row whose number does
        // still has its date sealed.
        if (r.dob != null) {
          const done = await client.query(
            `UPDATE users SET date_of_birth_enc = $2, date_of_birth = NULL
              WHERE id = $1 AND date_of_birth = $3::date`,
            [r.id, sealDob(r.id, r.dob, cipher), r.dob],
          );
          if (done.rowCount === 0) {
            result.deferred += 1;
            continue;
          }
        }
        if (r.phone == null) {
          result.sealed += 1;
          continue;
        }
        // A savepoint per row, so one duplicate number does not roll back the batch.
        await client.query("SAVEPOINT pii_row");
        try {
          const sealed = sealPhone(r.id, r.phone, cipher);
          const done = await client.query(
            `UPDATE users SET phone_enc = $2, phone_hash = $3, phone_last4 = $4, phone = NULL
              WHERE id = $1 AND phone = $5`,
            [r.id, sealed.phone_enc, sealed.phone_hash, sealed.phone_last4, r.phone],
          );
          if (done.rowCount === 0) {
            // Not re-keying the block either: the number read is no longer this row's.
            await client.query("RELEASE SAVEPOINT pii_row");
            result.deferred += 1;
            continue;
          }
          await client.query(
            `UPDATE phone_blocks SET phone_hmac = $2
              WHERE phone_hmac = $1
                AND NOT EXISTS (SELECT 1 FROM phone_blocks WHERE phone_hmac = $2)`,
            [legacyPhoneHmac(r.phone), sealed.phone_hash],
          );
          await client.query("RELEASE SAVEPOINT pii_row");
          result.sealed += 1;
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT pii_row");
          // 23505: another account already holds this number's index. Left in the clear
          // rather than guessed at — merging or deleting an account is a human decision.
          if ((err as { code?: string }).code !== "23505") throw err;
          result.conflicts += 1;
          log.warn("user not sealed: another account has the same phone number", {
            userId: r.id,
          });
        }
      }
    });
  }
}

/** The applicant's number on each helper application. No index and no uniqueness — nothing
 *  looks an application up by number — so there is nothing to conflict on. */
async function sealApplications(
  client: Client,
  cipher: PiiCipher,
  batchSize: number,
  result: BackfillResult,
): Promise<void> {
  let after = "";
  for (;;) {
    const { rows } = await client.query<{ id: string; phone: string }>(
      `SELECT id, phone FROM helper_applications
        WHERE phone IS NOT NULL AND id > $1
        ORDER BY id
        LIMIT $2`,
      [after, batchSize],
    );
    if (rows.length === 0) return;
    after = rows[rows.length - 1].id;

    await inTransaction(client, async () => {
      for (const r of rows) {
        const done = await client.query(
          `UPDATE helper_applications SET phone_enc = $2, phone = NULL
            WHERE id = $1 AND phone = $3`,
          [r.id, sealApplicationPhone(r.id, r.phone, cipher), r.phone],
        );
        if (done.rowCount === 0) result.deferred += 1;
        else result.applicationsSealed += 1;
      }
    });
  }
}
