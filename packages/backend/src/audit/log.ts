import type { PoolClient } from "pg";
import type { DbPool } from "../db.js";
import { logger } from "../logger.js";
import { AUDIT_CHAIN_LOCK_KEY, auditRowHash, GENESIS_HASH, type ChainedRow } from "./chain.js";

/** ── Audit log ─────────────────────────────────────────────────────────────
 *  AGENTS.md: "Immutable, append-only audit log for every SOS trigger, KYC review action, and
 *  admin override." This is that log.
 *
 *  Append-only is enforced in the DATABASE, not by the convention that this module has no
 *  update method: migration 3 installs `DO INSTEAD NOTHING` rules on UPDATE and DELETE, and the
 *  runtime role (dbRoles.ts) holds only SELECT and INSERT on the table and owns nothing, so it
 *  can neither rewrite rows nor drop the rules. A log the application can rewrite is not
 *  evidence of anything — the first thing a compromised admin session does is delete its own
 *  trail. For whoever gets past that, every row is hash-chained (chain.ts), so the rewriting
 *  shows.
 *
 *  Reading a KYC document is itself an audited action. "Who looked at this person's Aadhaar,
 *  and when" is a question a trust & safety platform must be able to answer about its own
 *  staff, and it is not answerable after the fact if nobody wrote it down at the time.
 */

/** Actions are a closed set rather than free strings, so a typo produces a compile error
 *  instead of an event that silently never matches the query looking for it. */
export type AuditAction =
  // identity / onboarding
  | "onboarding.identity_submitted"
  | "onboarding.document_uploaded"
  | "onboarding.submitted_for_review"
  | "onboarding.approved"
  | "onboarding.rejected"
  // admin handling of other people's data
  | "admin.document_viewed"
  | "admin.user_blocked"
  /** A super admin created an operator account. Never records the password — what matters
   *  later is who was made staff, by whom, and on which number. */
  | "admin.staff_created"
  /** Staff issued a temporary password for another account. The credential is never recorded
   *  — what matters afterwards is that a human did this, to whom, and when. */
  | "admin.password_set"
  | "admin.user_unblocked"
  | "admin.role_changed"
  // staff second factor. Never records a code or the secret — what matters afterwards is
  // that the strongest lock on a staff account was added, removed or bypassed, and when.
  | "auth.totp_enrolled"
  | "auth.totp_disabled"
  /** A recovery code was spent in place of an authenticator code. Legitimate when a phone is
   *  lost; also exactly what it looks like when a printed sheet of codes has been found. */
  | "auth.totp_recovery_code_used"
  // safety
  | "sos.raised"
  /** An operator took ownership. Recorded separately from `sos.resolved` because how long an
   *  alarm waited before a human answered it is the number this platform should be judged on,
   *  and it is not recoverable from the resolution alone. */
  | "sos.acknowledged"
  | "sos.resolved"
  // abuse review. The signals themselves live in `abuse_signals`; these are the human
  // judgements about them, kept here so an observation and the decision taken on it survive
  // independently of each other.
  | "abuse.reviewed";

export interface AuditEntry {
  action: AuditAction;
  /** Who did it. Null for system-originated events (a sweep, a provider callback). */
  actorId: string | null;
  actorRole?: string | null;
  /** What it was done to. */
  subjectType?: "user" | "task" | "document" | "sos" | null;
  subjectId?: string | null;
  /** Anything else worth keeping. MUST NOT contain credentials, OTPs, full phone numbers or
   *  Aadhaar digits — this table is long-lived and widely readable by staff. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditLogger {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * Postgres-backed writer.
 *
 * Every row is chained to the one before it (see chain.ts). The chain only means anything if
 * "the row before it" is well defined, so an insert is: take the chain lock, read the newest
 * hash, draw the id, hash, insert, commit — all in one transaction. Two concurrent inserts
 * that skipped the lock would both chain onto the same parent and the log would fork, which
 * the verifier cannot tell apart from tampering. The cost is that audit writes queue behind
 * each other; they are a handful per admin action, not per request.
 *
 * The id is drawn with `nextval` before the INSERT, under the lock, because it is part of what
 * is hashed: a row cannot be renumbered without the hash noticing. Drawing it under the lock is
 * also what makes id order and chain order the same. Migration 15's trigger holds every
 * inserter to this — the drawn id, after every existing row, onto the current head — so the
 * runtime role's INSERT privilege is not also a way to pick those columns.
 *
 * The lock is an advisory one, not `LOCK TABLE`: a lock mode strong enough to exclude other
 * inserters needs UPDATE or DELETE on the table, which is exactly what the runtime role is
 * denied.
 *
 * A failed audit write is logged loudly but does NOT throw. That is a deliberate trade and it
 * cuts against the usual instinct, so the reasoning matters: the alternative is that a full
 * disk or a lock timeout on this table turns every admin approval into a 500. Losing one audit
 * row to an outage is bad; making the platform's safety operations unavailable whenever the
 * log is degraded is worse, and would create pressure to disable auditing to restore service.
 *
 * The error is emitted at `error` level with the entry attached so the event survives in the
 * application log even when the table write failed.
 */
export function createPgAuditLogger(pool: DbPool, now: () => number): AuditLogger {
  return {
    async record(entry) {
      let client: PoolClient | null = null;
      // Set when ROLLBACK itself failed: the connection is broken, or still inside an aborted
      // transaction, and handing it back to the pool would fail whichever unrelated request
      // drew it next. Released with the error instead, which makes pg destroy it.
      let discard: Error | undefined;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_CHAIN_LOCK_KEY]);
        const head = await client.query<{ row_hash: string }>(
          `SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1`,
        );
        const prevHash = head.rows[0]?.row_hash ?? GENESIS_HASH;
        const { rows } = await client.query<{ id: string }>(
          `SELECT nextval(pg_get_serial_sequence('audit_log', 'id'))::text AS id`,
        );
        // Through JSON once, so what is hashed is what JSONB will hand back: Dates become
        // strings and undefined members disappear here, exactly as they do in the column.
        const metadata = JSON.parse(JSON.stringify(entry.metadata ?? {})) as unknown;
        const at = now();
        const row: ChainedRow = {
          id: rows[0]!.id,
          at: String(at),
          action: entry.action,
          actorId: entry.actorId,
          actorRole: entry.actorRole ?? null,
          subjectType: entry.subjectType ?? null,
          subjectId: entry.subjectId ?? null,
          ip: entry.ip ?? null,
          metadata,
        };
        await client.query(
          `INSERT INTO audit_log
             (id, actor_id, actor_role, action, subject_type, subject_id, metadata, ip, at,
              prev_hash, row_hash)
           VALUES ($1::bigint,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,
          [
            row.id,
            row.actorId,
            row.actorRole,
            row.action,
            row.subjectType,
            row.subjectId,
            JSON.stringify(metadata),
            row.ip,
            at,
            prevHash,
            auditRowHash(prevHash, row),
          ],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client?.query("ROLLBACK").catch((rollbackErr: unknown) => {
          discard = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        });
        logger.error("AUDIT WRITE FAILED — event recorded here instead", {
          action: entry.action,
          actorId: entry.actorId,
          subjectType: entry.subjectType,
          subjectId: entry.subjectId,
          err: String(err),
        });
      } finally {
        client?.release(discard);
      }
    },
  };
}

/** No-Postgres fallback (tests, and the dev boot without a database). Writes to the
 *  application log so the flow is still observable, and is explicit about not being durable. */
export function createLoggingAuditLogger(): AuditLogger {
  return {
    async record(entry) {
      logger.info("audit (non-durable — no database configured)", {
        action: entry.action,
        actorId: entry.actorId,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
      });
    },
  };
}

/** Rows as the admin surface reads them back. */
export interface AuditRow extends AuditEntry {
  id: string;
  at: number;
}

export async function readAuditLog(
  pool: DbPool,
  filter: { subjectType?: string; subjectId?: string; actorId?: string; limit?: number },
): Promise<AuditRow[]> {
  // Capped hard: this table only grows, and an unbounded SELECT against it is a slow query
  // waiting to happen the first time someone opens the page on a busy deployment.
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const { rows } = await pool.query<{
    id: string;
    actor_id: string | null;
    actor_role: string | null;
    action: string;
    subject_type: string | null;
    subject_id: string | null;
    metadata: Record<string, unknown>;
    ip: string | null;
    at: string | number;
  }>(
    `SELECT id, actor_id, actor_role, action, subject_type, subject_id, metadata, ip, at
       FROM audit_log
      WHERE ($1::text IS NULL OR subject_type = $1)
        AND ($2::text IS NULL OR subject_id = $2)
        AND ($3::text IS NULL OR actor_id = $3)
      ORDER BY at DESC
      LIMIT $4`,
    [filter.subjectType ?? null, filter.subjectId ?? null, filter.actorId ?? null, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    actorId: r.actor_id,
    actorRole: r.actor_role,
    action: r.action as AuditAction,
    subjectType: r.subject_type as AuditEntry["subjectType"],
    subjectId: r.subject_id,
    metadata: r.metadata ?? {},
    ip: r.ip,
    at: Number(r.at),
  }));
}
