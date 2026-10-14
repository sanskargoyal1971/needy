import { createHash } from "node:crypto";
import type { DbPool } from "../db.js";

/** ── The audit log's hash chain ────────────────────────────────────────────
 *  Each row stores `prev_hash`, the `row_hash` of the row before it, and
 *  `row_hash = SHA-256(prev_hash || "\n" || canonical row)`. Editing a row breaks its own hash;
 *  removing one breaks the next row's `prev_hash`; slipping one in without a hash leaves a gap.
 *  Whichever happened, the verifier names where the chain stops holding, and keeps going.
 *  Migration 15's trigger stops the runtime role inserting a row that is unhashed, out of id
 *  order or not chained onto the head, so those breaks take the owner's privileges to make.
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

export interface ChainBreakAt {
  id: string;
  /** 1-based, in id order, over every row in the table. */
  position: number;
  reason: ChainBreak;
}

export interface AuditChainReport {
  /** True when every row above the recorded chain start verifies, and the number of rows at
   *  or below it is still the number recorded when the start was fixed. */
  ok: boolean;
  /** Chained rows whose links hold. */
  checked: number;
  /** Rows at or below the recorded chain start: written before migration 14 added the hash
   *  columns, so not verifiable one by one. */
  legacyUnchained: number;
  /** How many there were when migration 15 recorded the start. A different `legacyUnchained`
   *  means rows were added to or removed from the unverifiable prefix, and fails `ok`. Null
   *  when the record itself is gone, which fails `ok` too. */
  legacyRecorded: number | null;
  /** The newest chained row: the one the next write chains onto. Record `headHash` outside
   *  this database: a later report whose chain no longer passes through it means history was
   *  rewritten. */
  headId: string | null;
  headHash: string | null;
  /** The first and last rows where the chain does not hold, and how many there are. The walk
   *  does not stop at a break, so one planted row cannot hide what comes after it. */
  firstBroken: ChainBreakAt | null;
  lastBroken: ChainBreakAt | null;
  brokenCount: number;
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
  legacy: boolean;
}

/**
 * Walk the whole log in id order and report every broken link.
 *
 * Batched by keyset rather than one SELECT, because this table only grows and the walk must
 * not hold the whole of it in memory. Read-only: it runs as the runtime role.
 *
 * After a break the walk re-anchors on the broken row's own stored `row_hash`, because that is
 * what the next honest write chained onto: an edited row breaks itself, a deleted one breaks
 * its successor, and the rows after either still verify. Stopping at the first break instead
 * let a single planted row blind every report from then on.
 *
 * Where the unhashed prefix ends comes from `audit_chain_start`, recorded by migration 15,
 * not from the data: worked out from the data, nulling every hash moved it to the end and the
 * whole log passed as "legacy". That record can itself be rewritten by someone who can
 * rewrite this table, which is why `legacyUnchained` belongs beside `headHash` in whatever is
 * written down outside the database.
 *
 * Rows committed while the walk runs are fine. Inserts take the chain lock and an id under it,
 * so a row cannot commit with an id below one already visible.
 */
export async function verifyAuditChain(
  pool: DbPool,
  opts: { batchSize?: number } = {},
): Promise<AuditChainReport> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? 1000, 1), 10_000);

  const start = await pool.query<{ legacy_max_id: string; legacy_rows: string }>(
    `SELECT legacy_max_id::text, legacy_rows::text FROM audit_chain_start`,
  );
  // A missing record allows no legacy rows at all: every unhashed row is then a break.
  const legacyMaxId = start.rows[0]?.legacy_max_id ?? null;
  const legacyRecorded = start.rows[0] ? Number(start.rows[0].legacy_rows) : null;

  // Null, not "0": an id at or below zero is still a row, and the walk must reach it.
  let after: string | null = null;
  let position = 0;
  let checked = 0;
  let legacyUnchained = 0;
  let expectedPrev = GENESIS_HASH;
  let headId: string | null = null;
  let headHash: string | null = null;
  let firstBroken: ChainBreakAt | null = null;
  let lastBroken: ChainBreakAt | null = null;
  let brokenCount = 0;

  const broke = (at: ChainBreakAt) => {
    firstBroken ??= at;
    lastBroken = at;
    brokenCount += 1;
  };

  for (;;) {
    const { rows }: { rows: AuditDbRow[] } = await pool.query<AuditDbRow>(
      `SELECT id::text, at::text, action, actor_id, actor_role, subject_type, subject_id, ip,
              metadata, prev_hash, row_hash,
              coalesce(audit_log.id <= $3::bigint, false) AS legacy
         FROM audit_log
        WHERE $1::bigint IS NULL OR audit_log.id > $1::bigint
        -- Qualified: a bare "id" here binds to the id::text output column, and text order
        -- puts 10 before 2.
        ORDER BY audit_log.id
        LIMIT $2`,
      [after, batchSize, legacyMaxId],
    );
    if (rows.length === 0) break;

    for (const r of rows) {
      position += 1;
      if (r.legacy) {
        legacyUnchained += 1;
        continue;
      }
      if (r.row_hash == null) {
        // Nothing to re-anchor on: the next honest write chained past this row, onto the
        // last hashed one, so `expectedPrev` stays where it is.
        broke({ id: r.id, position, reason: "unchained_row" });
        continue;
      }
      if (r.prev_hash !== expectedPrev) {
        broke({ id: r.id, position, reason: "prev_hash_mismatch" });
      } else {
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
        if (recomputed !== r.row_hash) broke({ id: r.id, position, reason: "row_hash_mismatch" });
        else checked += 1;
      }
      expectedPrev = r.row_hash;
      headId = r.id;
      headHash = r.row_hash;
    }
    after = rows[rows.length - 1]!.id;
  }

  return {
    ok: brokenCount === 0 && legacyRecorded === legacyUnchained,
    checked,
    legacyUnchained,
    legacyRecorded,
    headId,
    headHash,
    firstBroken,
    lastBroken,
    brokenCount,
  };
}
