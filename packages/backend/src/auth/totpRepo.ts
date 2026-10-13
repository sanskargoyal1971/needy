import type { DbPool } from "../db.js";

/** ── Where the second factor lives ─────────────────────────────────────────
 *  Its own table and its own repository, not columns on `users`.
 *
 *  The password hash is a column on `users` that `rowToUser` is trusted never to map. That
 *  works, but it rests on every `SELECT * FROM users` anywhere — the admin listings, a future
 *  export — remembering to leave it behind. A TOTP secret is worse to leak than a password
 *  hash (it is the credential itself, merely encrypted), so it is kept where a query about
 *  users cannot return it at all.
 */

export interface TotpCredential {
  userId: string;
  /** AES-256-GCM ciphertext of the shared secret — see `encryptTotpSecret`. Never the secret. */
  secretEnc: string;
  /** `pending` until a first code proves the app really holds the secret. A pending
   *  credential is not a second factor and is never accepted at sign-in. */
  status: "pending" | "active";
  /** The newest time-step already accepted, so the same code cannot be used twice. */
  lastStep: number | null;
  createdAt: number;
  activatedAt: number | null;
}

export interface TotpRepository {
  get(userId: string): Promise<TotpCredential | null>;

  /**
   * Store a freshly generated secret, awaiting its first code.
   *
   * Replaces an earlier PENDING secret — someone who closed the tab half way through starts
   * again with a new one. Resolves false, and changes nothing, if the account already has an
   * ACTIVE one: enrolment must never be a way to swap a working second factor for the
   * caller's own without first proving possession of the old one.
   */
  savePending(userId: string, secretEnc: string, at: number): Promise<boolean>;

  /**
   * Pending → active, recording the step that proved it and the recovery-code hashes.
   *
   * Resolves true only for the call that actually flipped it. Two confirmations racing must
   * not both mint a set of recovery codes, or one browser is shown ten codes that were
   * overwritten a millisecond later.
   */
  activate(
    userId: string,
    step: number,
    at: number,
    recoveryCodeHashes: string[],
  ): Promise<boolean>;

  /**
   * Claim a time-step. True only if it is newer than every step accepted before.
   *
   * This is the replay check and it has to be ONE conditional write, not a read followed by a
   * write: two requests carrying the same captured code would otherwise both read the old
   * floor, both pass, and both be signed in.
   */
  acceptStep(userId: string, step: number): Promise<boolean>;

  /** Spend a recovery code. True exactly once per code. */
  consumeRecoveryCode(userId: string, codeHash: string, at: number): Promise<boolean>;
  recoveryCodesRemaining(userId: string): Promise<number>;

  /** Remove the credential and every recovery code that came with it. */
  remove(userId: string): Promise<void>;
}

// ── in-memory ────────────────────────────────────────────────────────────────

export function createInMemoryTotpRepo(): TotpRepository {
  const credentials = new Map<string, TotpCredential>();
  /** userId → codeHash → usedAt (null while unspent). */
  const recovery = new Map<string, Map<string, number | null>>();
  return {
    async get(userId) {
      const found = credentials.get(userId);
      return found ? { ...found } : null;
    },
    async savePending(userId, secretEnc, at) {
      if (credentials.get(userId)?.status === "active") return false;
      credentials.set(userId, {
        userId,
        secretEnc,
        status: "pending",
        lastStep: null,
        createdAt: at,
        activatedAt: null,
      });
      return true;
    },
    async activate(userId, step, at, recoveryCodeHashes) {
      const found = credentials.get(userId);
      if (!found || found.status !== "pending") return false;
      credentials.set(userId, { ...found, status: "active", lastStep: step, activatedAt: at });
      recovery.set(userId, new Map(recoveryCodeHashes.map((h) => [h, null])));
      return true;
    },
    async acceptStep(userId, step) {
      const found = credentials.get(userId);
      if (!found || found.status !== "active") return false;
      if (found.lastStep != null && step <= found.lastStep) return false;
      credentials.set(userId, { ...found, lastStep: step });
      return true;
    },
    async consumeRecoveryCode(userId, codeHash, at) {
      const codes = recovery.get(userId);
      if (credentials.get(userId)?.status !== "active" || !codes) return false;
      if (!codes.has(codeHash) || codes.get(codeHash) != null) return false;
      codes.set(codeHash, at);
      return true;
    },
    async recoveryCodesRemaining(userId) {
      return [...(recovery.get(userId)?.values() ?? [])].filter((used) => used == null).length;
    },
    async remove(userId) {
      credentials.delete(userId);
      recovery.delete(userId);
    },
  };
}

// ── postgres ─────────────────────────────────────────────────────────────────

interface TotpRow {
  user_id: string;
  secret_enc: string;
  status: string;
  last_step: number | string | null;
  created_at: number | string;
  activated_at: number | string | null;
}

export function createPgTotpRepo(pool: DbPool): TotpRepository {
  return {
    async get(userId) {
      const { rows } = await pool.query<TotpRow>(`SELECT * FROM user_totp WHERE user_id = $1`, [
        userId,
      ]);
      const r = rows[0];
      if (!r) return null;
      return {
        userId: r.user_id,
        secretEnc: r.secret_enc,
        status: r.status as TotpCredential["status"],
        lastStep: r.last_step == null ? null : Number(r.last_step),
        createdAt: Number(r.created_at),
        activatedAt: r.activated_at == null ? null : Number(r.activated_at),
      };
    },
    async savePending(userId, secretEnc, at) {
      // The `WHERE` on the conflict arm is the guard: an active row is left exactly as it was
      // and the statement reports zero rows, in one round trip with no window between a check
      // and a write.
      const { rowCount } = await pool.query(
        `INSERT INTO user_totp (user_id, secret_enc, status, last_step, created_at, activated_at)
         VALUES ($1, $2, 'pending', NULL, $3, NULL)
         ON CONFLICT (user_id) DO UPDATE
            SET secret_enc = EXCLUDED.secret_enc,
                created_at = EXCLUDED.created_at,
                last_step = NULL
          WHERE user_totp.status = 'pending'`,
        [userId, secretEnc, at],
      );
      return (rowCount ?? 0) > 0;
    },
    async activate(userId, step, at, recoveryCodeHashes) {
      // One statement, so it is atomic without a transaction: the codes are inserted only for
      // the row the UPDATE actually flipped, and a second racing confirmation flips nothing
      // and therefore inserts nothing.
      const { rowCount } = await pool.query(
        `WITH activated AS (
           UPDATE user_totp
              SET status = 'active', last_step = $2::bigint, activated_at = $3::bigint
            WHERE user_id = $1 AND status = 'pending'
        RETURNING user_id
         )
         INSERT INTO user_totp_recovery_codes (user_id, code_hash, created_at)
         SELECT activated.user_id, h, $3::bigint
           FROM activated CROSS JOIN unnest($4::text[]) AS h`,
        [userId, step, at, recoveryCodeHashes],
      );
      return (rowCount ?? 0) > 0;
    },
    async acceptStep(userId, step) {
      const { rowCount } = await pool.query(
        `UPDATE user_totp SET last_step = $2
          WHERE user_id = $1 AND status = 'active' AND (last_step IS NULL OR last_step < $2)`,
        [userId, step],
      );
      return (rowCount ?? 0) > 0;
    },
    async consumeRecoveryCode(userId, codeHash, at) {
      // The join is what makes a code useless once its credential is no longer active; the
      // `used_at IS NULL` is what makes it single-use under concurrency.
      const { rowCount } = await pool.query(
        `UPDATE user_totp_recovery_codes c
            SET used_at = $3
           FROM user_totp t
          WHERE c.user_id = $1 AND c.code_hash = $2 AND c.used_at IS NULL
            AND t.user_id = c.user_id AND t.status = 'active'`,
        [userId, codeHash, at],
      );
      return (rowCount ?? 0) > 0;
    },
    async recoveryCodesRemaining(userId) {
      const { rows } = await pool.query<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM user_totp_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
        [userId],
      );
      return Number(rows[0]?.n ?? 0);
    },
    async remove(userId) {
      // The recovery codes go with it by foreign key (ON DELETE CASCADE, migration 9), so a
      // disabled credential cannot leave working codes behind for the next enrolment to inherit.
      await pool.query(`DELETE FROM user_totp WHERE user_id = $1`, [userId]);
    },
  };
}
