import { OPEN_SOS_STATUSES, type SosAlert, type SosStatus } from "@needy/shared";
import type { DbPool } from "../db.js";

/** ── SOS persistence ───────────────────────────────────────────────────────
 *  An SOS alert MUST outlive the socket that raised it. The button used to be local
 *  component state: pressing it notified nobody and left no record, so nothing could be
 *  followed up, audited, or handed to an operator after the fact. Alerts are therefore
 *  durable and append-mostly — `cancel` records a stand-down rather than deleting the row,
 *  because "there was an alarm and it was withdrawn" is itself safety-relevant history.
 *
 *  The lifecycle methods below (`acknowledge`, `resolve`, `listOpen`, `listRecent`) are what
 *  the operator console is built on. Until they existed, `acknowledged` was a status in the
 *  type union that no code path could ever produce. */
export interface SosRepository {
  create(alert: SosAlert): Promise<SosAlert>;
  get(alertId: string): Promise<SosAlert | null>;
  setStatus(alertId: string, status: SosStatus, at: number): Promise<SosAlert | null>;
  /** Live (non-resolved, non-cancelled) alerts for a task — surfaced in the snapshot so a
   *  reconnecting client still sees that an alarm is active. */
  activeForTask(taskId: string): Promise<SosAlert[]>;

  /**
   * An operator takes ownership. Guarded to `raised` only: acknowledging an alert someone
   * else already resolved would reopen a closed case, and acknowledging one the raiser
   * cancelled would assert an emergency they have said is over.
   *
   * Returns null when the alert does not exist OR is no longer in `raised` — the caller
   * distinguishes the two with a separate read, because the second is a 409 and the first a
   * 404 and an operator deserves to know which.
   */
  acknowledge(alertId: string, operatorId: string, at: number): Promise<SosAlert | null>;

  /**
   * Close an alert with an account of what happened. Guarded to the open statuses, so
   * resolving twice is a no-op rather than a silent overwrite of the first operator's note.
   */
  resolve(alertId: string, operatorId: string, note: string, at: number): Promise<SosAlert | null>;

  /** The console's queue: everything still owed an answer, OLDEST FIRST. The person waiting
   *  longest is the one to answer next — see the index comment in migration 5. */
  listOpen(limit: number): Promise<SosAlert[]>;

  /** History, newest first. `statuses` empty means all. */
  listRecent(filter: { statuses?: readonly SosStatus[]; limit: number }): Promise<SosAlert[]>;

  /** How many alerts this user raised since `since`. Feeds the `sos.repeated` abuse signal,
   *  and is a cheap COUNT rather than a fetch-and-length because the caller only wants the
   *  number. */
  countRaisedBySince(userId: string, since: number): Promise<number>;

  /**
   * Record that on-call escalation step `fromStep + 1` (paging `tier`) is going out.
   *
   * A compare-and-set on BOTH the status and the step counter, and it is the second of the
   * escalation sweep's two exactly-once guards (the first is the Redis schedule claim):
   *   - `status = 'raised'` — an operator who acknowledged a moment ago must not be paged
   *     about an alarm they are already holding. Acknowledge runs the mirror-image predicate,
   *     so whichever commits first wins and the other matches nothing.
   *   - `escalation_step = fromStep` — two sweeps that both read step N cannot both send step
   *     N+1; the second matches nothing.
   *
   * Returns null when either guard fails, and the caller sends nothing.
   */
  recordEscalation(
    alertId: string,
    fromStep: number,
    tier: number,
    at: number,
  ): Promise<SosAlert | null>;

  /**
   * Alerts the escalation sweep may still owe a page: `raised`, with fewer than `belowStep`
   * pages sent. Oldest first, keyset-paged by (createdAt, id) after `after`.
   *
   * Its own query rather than `listOpen`, because `listOpen` is the CONSOLE's queue and holds
   * acknowledged alerts too. Acknowledged-but-unresolved alerts collect at the old end of that
   * list, and once there were a page's worth of them the reconcile pass never reached a raised
   * alert behind them — the newest alarm, the one most likely to have somebody still in danger.
   */
  listEscalatable(filter: {
    belowStep: number;
    after: { createdAt: number; id: string } | null;
    limit: number;
  }): Promise<SosAlert[]>;

  /**
   * Counts for the metrics scrape: how many alerts sit in each open status, and when the oldest
   * one nobody has acknowledged was raised (null when there is none).
   *
   * Its own aggregate rather than `listOpen(n).length`: that is capped at a page, so the number
   * would plateau exactly when it matters most, and its acknowledged rows sort ahead of raised
   * ones of the same age, so the oldest raised alarm could sit beyond the page altogether.
   * Counts and one timestamp only — nothing that names a person reaches the scrape.
   */
  openSummary(): Promise<{ raised: number; acknowledged: number; oldestRaisedAt: number | null }>;
}

// ── in-memory ────────────────────────────────────────────────────────────────

export function createInMemorySosRepo(): SosRepository {
  const byId = new Map<string, SosAlert>();
  const isOpen = (a: SosAlert) => OPEN_SOS_STATUSES.includes(a.status);
  return {
    async create(alert) {
      byId.set(alert.id, alert);
      return alert;
    },
    async get(alertId) {
      return byId.get(alertId) ?? null;
    },
    async setStatus(alertId, status, at) {
      const existing = byId.get(alertId);
      if (!existing) return null;
      const next: SosAlert = { ...existing, status, updatedAt: at };
      byId.set(alertId, next);
      return next;
    },
    async activeForTask(taskId) {
      return [...byId.values()].filter((a) => a.taskId === taskId && isOpen(a));
    },
    async acknowledge(alertId, operatorId, at) {
      const existing = byId.get(alertId);
      if (!existing || existing.status !== "raised") return null;
      const next: SosAlert = {
        ...existing,
        status: "acknowledged",
        acknowledgedBy: operatorId,
        acknowledgedAt: at,
        updatedAt: at,
      };
      byId.set(alertId, next);
      return next;
    },
    async resolve(alertId, operatorId, note, at) {
      const existing = byId.get(alertId);
      if (!existing || !isOpen(existing)) return null;
      const next: SosAlert = {
        ...existing,
        status: "resolved",
        resolvedBy: operatorId,
        resolutionNote: note,
        updatedAt: at,
      };
      byId.set(alertId, next);
      return next;
    },
    async listOpen(limit) {
      return [...byId.values()]
        .filter(isOpen)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit);
    },
    async listRecent({ statuses, limit }) {
      return [...byId.values()]
        .filter((a) => !statuses?.length || statuses.includes(a.status))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    },
    async countRaisedBySince(userId, since) {
      return [...byId.values()].filter((a) => a.raisedBy === userId && a.createdAt >= since).length;
    },
    async recordEscalation(alertId, fromStep, tier, at) {
      const existing = byId.get(alertId);
      if (!existing || existing.status !== "raised" || existing.escalationStep !== fromStep) {
        return null;
      }
      const next: SosAlert = {
        ...existing,
        escalationStep: fromStep + 1,
        escalationTier: tier,
        escalatedAt: at,
        updatedAt: at,
      };
      byId.set(alertId, next);
      return next;
    },
    async listEscalatable({ belowStep, after, limit }) {
      return [...byId.values()]
        .filter((a) => a.status === "raised" && a.escalationStep < belowStep)
        .filter(
          (a) =>
            after == null ||
            a.createdAt > after.createdAt ||
            (a.createdAt === after.createdAt && a.id > after.id),
        )
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit);
    },
    async openSummary() {
      const all = [...byId.values()];
      const raised = all.filter((a) => a.status === "raised");
      return {
        raised: raised.length,
        acknowledged: all.filter((a) => a.status === "acknowledged").length,
        oldestRaisedAt: raised.length > 0 ? Math.min(...raised.map((a) => a.createdAt)) : null,
      };
    },
  };
}

// ── postgres ─────────────────────────────────────────────────────────────────

interface SosRow {
  id: string;
  task_id: string;
  raised_by: string;
  kind: string;
  status: string;
  at_lat: number | null;
  at_lng: number | null;
  note: string | null;
  acknowledged_by: string | null;
  acknowledged_at: number | string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  escalation_step: number | string;
  escalation_tier: number | string;
  escalated_at: number | string | null;
  created_at: number | string;
  updated_at: number | string;
}

function rowToAlert(r: SosRow): SosAlert {
  return {
    id: r.id,
    taskId: r.task_id,
    raisedBy: r.raised_by,
    kind: r.kind as SosAlert["kind"],
    status: r.status as SosStatus,
    at:
      r.at_lat != null && r.at_lng != null
        ? { lat: Number(r.at_lat), lng: Number(r.at_lng) }
        : null,
    note: r.note,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedAt: r.acknowledged_at == null ? null : Number(r.acknowledged_at),
    resolvedBy: r.resolved_by,
    resolutionNote: r.resolution_note,
    escalationStep: Number(r.escalation_step),
    escalationTier: Number(r.escalation_tier),
    escalatedAt: r.escalated_at == null ? null : Number(r.escalated_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function createPgSosRepo(pool: DbPool): SosRepository {
  return {
    async create(alert) {
      await pool.query(
        `INSERT INTO sos_alerts
           (id, task_id, raised_by, kind, status, at_lat, at_lng, note,
            escalation_step, escalation_tier, escalated_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          alert.id,
          alert.taskId,
          alert.raisedBy,
          alert.kind,
          alert.status,
          alert.at?.lat ?? null,
          alert.at?.lng ?? null,
          alert.note,
          alert.escalationStep,
          alert.escalationTier,
          alert.escalatedAt,
          alert.createdAt,
          alert.updatedAt,
        ],
      );
      return alert;
    },
    async get(alertId) {
      const { rows } = await pool.query<SosRow>(`SELECT * FROM sos_alerts WHERE id = $1`, [
        alertId,
      ]);
      return rows[0] ? rowToAlert(rows[0]) : null;
    },
    async setStatus(alertId, status, at) {
      // Single guarded UPDATE ... RETURNING rather than read-modify-write, so two
      // concurrent status changes cannot lose one another (cf. the audit's C14 finding
      // about pgTaskRepo.update).
      const { rows } = await pool.query<SosRow>(
        `UPDATE sos_alerts SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
        [alertId, status, at],
      );
      return rows[0] ? rowToAlert(rows[0]) : null;
    },
    async activeForTask(taskId) {
      const { rows } = await pool.query<SosRow>(
        `SELECT * FROM sos_alerts
          WHERE task_id = $1 AND status NOT IN ('resolved','cancelled')
          ORDER BY created_at ASC`,
        [taskId],
      );
      return rows.map(rowToAlert);
    },
    async acknowledge(alertId, operatorId, at) {
      // The `status = 'raised'` predicate IS the concurrency control: two operators clicking
      // acknowledge at the same moment both run this statement, and exactly one matches a row.
      // The loser gets null and is told the alert is already owned — which is the truth, and
      // is more useful to them than a silent success that overwrites a colleague's name.
      const { rows } = await pool.query<SosRow>(
        `UPDATE sos_alerts
            SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3,
                updated_at = $3
          WHERE id = $1 AND status = 'raised'
          RETURNING *`,
        [alertId, operatorId, at],
      );
      return rows[0] ? rowToAlert(rows[0]) : null;
    },
    async resolve(alertId, operatorId, note, at) {
      const { rows } = await pool.query<SosRow>(
        `UPDATE sos_alerts
            SET status = 'resolved', resolved_by = $2, resolution_note = $3, updated_at = $4
          WHERE id = $1 AND status IN ('raised','acknowledged')
          RETURNING *`,
        [alertId, operatorId, note, at],
      );
      return rows[0] ? rowToAlert(rows[0]) : null;
    },
    async listOpen(limit) {
      const { rows } = await pool.query<SosRow>(
        `SELECT * FROM sos_alerts
          WHERE status IN ('raised','acknowledged')
          ORDER BY created_at ASC
          LIMIT $1`,
        [limit],
      );
      return rows.map(rowToAlert);
    },
    async listRecent({ statuses, limit }) {
      const { rows } = await pool.query<SosRow>(
        `SELECT * FROM sos_alerts
          WHERE ($1::text[] IS NULL OR status = ANY($1))
          ORDER BY created_at DESC
          LIMIT $2`,
        [statuses?.length ? [...statuses] : null, limit],
      );
      return rows.map(rowToAlert);
    },
    async countRaisedBySince(userId, since) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM sos_alerts WHERE raised_by = $1 AND created_at >= $2`,
        [userId, since],
      );
      return Number(rows[0]?.count ?? 0);
    },
    async recordEscalation(alertId, fromStep, tier, at) {
      // One guarded UPDATE, for the same reason `acknowledge` is one: the predicate is the
      // concurrency control, and a read-then-write would let an acknowledgement land between
      // the two and still be paged about.
      const { rows } = await pool.query<SosRow>(
        `UPDATE sos_alerts
            SET escalation_step = $2::int + 1, escalation_tier = $3::int, escalated_at = $4::bigint,
                updated_at = $4
          WHERE id = $1 AND status = 'raised' AND escalation_step = $2::int
          RETURNING *`,
        [alertId, fromStep, tier, at],
      );
      return rows[0] ? rowToAlert(rows[0]) : null;
    },
    async listEscalatable({ belowStep, after, limit }) {
      // Served by idx_sos_open_queue (created_at, partial on the open statuses); `raised` is a
      // subset of that predicate. The row-value comparison is the keyset cursor. `COLLATE "C"`
      // so the tiebreak orders ids by byte, the same way the in-memory twin compares strings.
      const { rows } = await pool.query<SosRow>(
        `SELECT * FROM sos_alerts
          WHERE status = 'raised' AND escalation_step < $1::int
            AND ($2::bigint IS NULL OR (created_at, id COLLATE "C") > ($2::bigint, $3::text COLLATE "C"))
          ORDER BY created_at ASC, id COLLATE "C" ASC
          LIMIT $4`,
        [belowStep, after?.createdAt ?? null, after?.id ?? null, limit],
      );
      return rows.map(rowToAlert);
    },
    async openSummary() {
      // One pass over the partial open-queue index; the FILTERs split it by status.
      const { rows } = await pool.query<{
        raised: string | number;
        acknowledged: string | number;
        oldest_raised_at: string | number | null;
      }>(
        `SELECT count(*) FILTER (WHERE status = 'raised')        AS raised,
                count(*) FILTER (WHERE status = 'acknowledged')  AS acknowledged,
                min(created_at) FILTER (WHERE status = 'raised') AS oldest_raised_at
           FROM sos_alerts
          WHERE status IN ('raised','acknowledged')`,
      );
      const r = rows[0]!;
      return {
        raised: Number(r.raised),
        acknowledged: Number(r.acknowledged),
        oldestRaisedAt: r.oldest_raised_at == null ? null : Number(r.oldest_raised_at),
      };
    },
  };
}
