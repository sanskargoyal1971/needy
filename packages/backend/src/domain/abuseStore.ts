import {
  ABUSE_SIGNAL_WEIGHTS,
  isAbuseSignalKind,
  type AbuseSignal,
  type AbuseSignalKind,
} from "@needy/shared";
import type { DbPool } from "../db.js";
import { logger } from "../logger.js";

/** ── Abuse signal persistence ──────────────────────────────────────────────
 *  Append-only, enforced by rules in migration 5 rather than by this module having no update
 *  method — the same reasoning as `audit/log.ts`. A signal is an observation a human will
 *  later judge; an observation the application can rewrite is worth nothing as evidence.
 *
 *  There is deliberately no `dismiss` here. An operator who decides a signal was noise records
 *  that decision in the audit log, where it sits beside the observation instead of replacing
 *  it. "We saw this and concluded it was fine" and "we never saw this" must not look the same
 *  in six months.
 */

/** What the queue needs about one user before their identity is attached. The identity join
 *  happens in the router against `UserRepository`, so both implementations of this interface
 *  behave identically and phone masking stays in exactly one place. */
export interface AbuseTally {
  subjectId: string;
  /** Sum of weights over the window — the sort key. */
  score: number;
  total: number;
  byKind: Partial<Record<AbuseSignalKind, number>>;
  firstAt: number;
  lastAt: number;
}

export interface AbuseRepository {
  record(signal: Omit<AbuseSignal, "id">): Promise<void>;
  /** Per-user rollup over a window, highest score first. */
  tally(filter: { since: number; limit: number }): Promise<AbuseTally[]>;
  /** The individual observations behind one user's score. */
  listForSubject(subjectId: string, since: number, limit: number): Promise<AbuseSignal[]>;
}

/**
 * Emit a signal without letting it break the thing that produced it.
 *
 * Every call site is inside a request that is doing something more important than
 * bookkeeping — refusing a flood, burning a handoff code, closing a task. A failed INSERT
 * here must never turn one of those into a 500, so this swallows and logs, exactly as
 * `createPgAuditLogger` does and for the same reason. The signal is not silently lost: the
 * error line carries it, so it survives in the application log.
 *
 * Returns a promise that never rejects, and callers `await` it. Fire-and-forget was the first
 * shape and was wrong twice over: the write could still be in flight when the response went
 * out (so a test — and an operator refreshing the console — could look before it landed), and
 * a rejection escaping an un-awaited promise reaches `unhandledRejection` rather than the
 * handler above. Awaiting costs one small INSERT on paths that are already several awaits deep
 * into Redis and Postgres.
 */
export async function emitSignal(
  repo: AbuseRepository,
  kind: AbuseSignalKind,
  subjectId: string,
  at: number,
  opts: { taskId?: string | null; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  await repo
    .record({
      kind,
      subjectId,
      taskId: opts.taskId ?? null,
      weight: ABUSE_SIGNAL_WEIGHTS[kind],
      metadata: opts.metadata ?? {},
      at,
    })
    .catch((err: unknown) => {
      logger.error("ABUSE SIGNAL NOT PERSISTED — recorded here instead", {
        kind,
        subjectId,
        taskId: opts.taskId ?? null,
        err: String(err),
      });
    });
}

// ── in-memory ────────────────────────────────────────────────────────────────

export function createInMemoryAbuseRepo(): AbuseRepository {
  const rows: AbuseSignal[] = [];
  let seq = 0;
  return {
    async record(signal) {
      rows.push({ ...signal, id: String(++seq) });
    },
    async tally({ since, limit }) {
      const bySubject = new Map<string, AbuseTally>();
      for (const r of rows) {
        if (r.at < since) continue;
        const existing = bySubject.get(r.subjectId) ?? {
          subjectId: r.subjectId,
          score: 0,
          total: 0,
          byKind: {},
          firstAt: r.at,
          lastAt: r.at,
        };
        existing.score += r.weight;
        existing.total += 1;
        existing.byKind[r.kind] = (existing.byKind[r.kind] ?? 0) + 1;
        existing.firstAt = Math.min(existing.firstAt, r.at);
        existing.lastAt = Math.max(existing.lastAt, r.at);
        bySubject.set(r.subjectId, existing);
      }
      return [...bySubject.values()]
        .sort((a, b) => b.score - a.score || b.lastAt - a.lastAt)
        .slice(0, limit);
    },
    async listForSubject(subjectId, since, limit) {
      return rows
        .filter((r) => r.subjectId === subjectId && r.at >= since)
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    },
  };
}

// ── postgres ─────────────────────────────────────────────────────────────────

export function createPgAbuseRepo(pool: DbPool): AbuseRepository {
  return {
    async record(signal) {
      await pool.query(
        `INSERT INTO abuse_signals (kind, subject_id, task_id, weight, metadata, at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [
          signal.kind,
          signal.subjectId,
          signal.taskId,
          signal.weight,
          JSON.stringify(signal.metadata ?? {}),
          signal.at,
        ],
      );
    },
    async tally({ since, limit }) {
      // The per-kind breakdown is aggregated in SQL rather than by fetching every row and
      // counting in JS: a busy week is a lot of rows to ship across the wire just to produce
      // six integers, and this table only grows.
      const { rows } = await pool.query<{
        subject_id: string;
        score: string;
        total: string;
        first_at: string;
        last_at: string;
        by_kind: Record<string, number> | null;
      }>(
        // Two-level aggregate: group by (subject, kind) first, then roll those groups up per
        // subject. The inner counts are exactly the per-kind breakdown, so the outer level
        // gets it for free from `jsonb_object_agg` instead of a second pass over the table.
        `SELECT subject_id,
                SUM(kind_score)            AS score,
                SUM(kind_total)            AS total,
                MIN(kind_first)            AS first_at,
                MAX(kind_last)             AS last_at,
                jsonb_object_agg(kind, kind_total) AS by_kind
           FROM (
             SELECT subject_id,
                    kind,
                    SUM(weight) AS kind_score,
                    COUNT(*)    AS kind_total,
                    MIN(at)     AS kind_first,
                    MAX(at)     AS kind_last
               FROM abuse_signals
              WHERE at >= $1
              GROUP BY subject_id, kind
           ) s
          GROUP BY subject_id
          ORDER BY score DESC, last_at DESC
          LIMIT $2`,
        [since, limit],
      );
      return rows.map((r) => ({
        subjectId: r.subject_id,
        score: Number(r.score),
        total: Number(r.total),
        // Unknown kinds are dropped rather than trusted into the typed map: a row written by
        // an older deploy whose kind has since been removed should not appear as a phantom
        // column in a console that assumes the current union.
        byKind: Object.fromEntries(
          Object.entries(r.by_kind ?? {}).filter(([k]) => isAbuseSignalKind(k)),
        ) as Partial<Record<AbuseSignalKind, number>>,
        firstAt: Number(r.first_at),
        lastAt: Number(r.last_at),
      }));
    },
    async listForSubject(subjectId, since, limit) {
      const { rows } = await pool.query<{
        id: string;
        kind: string;
        subject_id: string;
        task_id: string | null;
        weight: number;
        metadata: Record<string, unknown> | null;
        at: string | number;
      }>(
        `SELECT id, kind, subject_id, task_id, weight, metadata, at
           FROM abuse_signals
          WHERE subject_id = $1 AND at >= $2
          ORDER BY at DESC
          LIMIT $3`,
        [subjectId, since, limit],
      );
      return rows.map((r) => ({
        id: String(r.id),
        kind: r.kind as AbuseSignalKind,
        subjectId: r.subject_id,
        taskId: r.task_id,
        weight: Number(r.weight),
        metadata: r.metadata ?? {},
        at: Number(r.at),
      }));
    },
  };
}
