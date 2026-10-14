import { createHash } from "node:crypto";
import type { DbPool } from "../db.js";

/** ── The audit log's hash chain ────────────────────────────────────────────
 *  Each row stores `prev_hash`, the `row_hash` of the row before it, and
 *  `row_hash = SHA-256(prev_hash || "\n" || canonical row)`. Editing a row breaks its own hash;
 *  removing one breaks the next row's `prev_hash`; slipping one in without a hash leaves a gap.
 *  Whichever happened, the verifier names the first row where the chain stops holding.
 *
 *  What this does NOT do, stated plainly so nobody leans on it for more: there is no secret in
 *  the hash, so someone with superuser access and patience can recompute every hash after the
 *  row they changed, and the chain verifies again. It also cannot see the newest rows being
 *  cut off the end. Both are answered by recording the head hash somewhere this database's
 *  administrators cannot write (the verify report returns it for exactly that), and comparing
 *  later — a chain whose head no longer extends a recorded head has been rewritten.
 *
 *  The role separation in dbRoles.ts is the prevention; this is the detection for whoever gets
 *  past it.
 */

/** `prev_hash` of the first chained row. */
export const GENESIS_HASH = "0".repeat(64);

/** Serialises inserts so each one chains onto the row committed before it. Fixed, and distinct
 *  from the migration ("need"), PII backfill ("npii") and grants ("nrol") keys. */
export const AUDIT_CHAIN_LOCK_KEY = 0x6e617564; // "naud"

/** The columns a hash covers, as text where Postgres hands them back as text (BIGINT). */
export interface ChainedRow {
  id: string;
  at: string;
  action: string;
  actorId: string | null;
  actorRole: string | null;
  subjectType: string | null;
  subjectId: string | null;
  ip: string | null;
  metadata: unknown;
}

/**
 * JSON with object keys sorted, recursively.
 *
 * Needed because `metadata` is JSONB, and JSONB does not keep the key order it was given — it
 * hands back `{"b":1,"a":2}` as `{"a":2,"b":1}`. Hashing `JSON.stringify` of what was inserted
 * and verifying against `JSON.stringify` of what was read would fail on every row with two
 * keys. Sorting on both sides makes order irrelevant. Written out rather than sorting and then
 * calling JSON.stringify, because JavaScript puts integer-like keys ("2", "10") first whatever
 * order an object is built in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // Numbers, strings and booleans exactly as JSON writes them; anything JSON drops
    // (undefined, a function) is null here, as it is in an array.
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** The exact bytes a row's hash covers. Positional, so no field can be confused for another. */
export function canonicalAuditRow(r: ChainedRow): string {
  return JSON.stringify([
    r.id,
    r.at,
    r.action,
    r.actorId,
    r.actorRole,
    r.subjectType,
    r.subjectId,
    r.ip,
  ]).concat("\n", canonicalJson(r.metadata));
}

export function auditRowHash(prevHash: string, row: ChainedRow): string {
  return createHash("sha256")
    .update(`${prevHash}\n${canonicalAuditRow(row)}`, "utf8")
    .digest("hex");
}

export type ChainBreak = "prev_hash_mismatch" | "row_hash_mismatch" | "unchained_row";

export interface AuditChainReport {
  /** True when every chained row verifies and nothing unchained follows the chain's start. */
  ok: boolean;
  /** Chained rows verified before the walk stopped (all of them when `ok`). */
  checked: number;
  /** Rows before the first chained one: written before migration 14 added the columns. Not
   *  verifiable, and reported so that number can be watched — it should never grow. */
  legacyUnchained: number;
  /** The last verified row. Record `headHash` outside this database: a later report whose
   *  chain no longer passes through it means history was rewritten. */
  headId: string | null;
  headHash: string | null;
  /** The first row where the chain does not hold. `position` is 1-based, in id order, over
   *  every row in the table. */
  firstBroken: { id: string; position: number; reason: ChainBreak } | null;
}

interface AuditDbRow {
  id: string;
  at: string;
  action: string;
  actor_id: string | null;
  actor_role: string | null;
  subject_type: string | null;
  subject_id: string | null;
  ip: string | null;
  metadata: unknown;
  prev_hash: string | null;
  row_hash: string | null;
}

/**
 * Walk the whole log in id order and report the first broken link.
 *
 * Batched by keyset rather than one SELECT, because this table only grows and the walk must
 * not hold the whole of it in memory. Read-only: it runs as the runtime role.
 *
 * Rows committed while the walk runs are fine. Inserts take the chain lock and an id under it,
 * so a row cannot commit with an id below one already visible.
 */
export async function verifyAuditChain(
  pool: DbPool,
  opts: { batchSize?: number } = {},
): Promise<AuditChainReport> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? 1000, 1), 10_000);
  let after = "0";
  let position = 0;
  let checked = 0;
  let legacyUnchained = 0;
  let started = false;
  let expectedPrev = GENESIS_HASH;
  let headId: string | null = null;
  let headHash: string | null = null;

  const report = (firstBroken: AuditChainReport["firstBroken"]): AuditChainReport => ({
    ok: firstBroken == null,
    checked,
    legacyUnchained,
    headId,
    headHash,
    firstBroken,
  });

  for (;;) {
    const { rows } = await pool.query<AuditDbRow>(
      `SELECT id::text, at::text, action, actor_id, actor_role, subject_type, subject_id, ip,
              metadata, prev_hash, row_hash
         FROM audit_log
        WHERE audit_log.id > $1::bigint
        -- Qualified: a bare "id" here binds to the id::text output column, and text order
        -- puts 10 before 2.
        ORDER BY audit_log.id
        LIMIT $2`,
      [after, batchSize],
    );
    if (rows.length === 0) return report(null);

    for (const r of rows) {
      position += 1;
      if (r.row_hash == null) {
        if (!started) {
          legacyUnchained += 1;
          continue;
        }
        return report({ id: r.id, position, reason: "unchained_row" });
      }
      started = true;
      if (r.prev_hash !== expectedPrev) {
        return report({ id: r.id, position, reason: "prev_hash_mismatch" });
      }
      const recomputed = auditRowHash(r.prev_hash, {
        id: r.id,
        at: r.at,
        action: r.action,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        ip: r.ip,
        metadata: r.metadata,
      });
      if (recomputed !== r.row_hash) {
        return report({ id: r.id, position, reason: "row_hash_mismatch" });
      }
      expectedPrev = r.row_hash;
      headId = r.id;
      headHash = r.row_hash;
      checked += 1;
    }
    after = rows[rows.length - 1]!.id;
  }
}
