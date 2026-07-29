import type { SosAlert, SosStatus } from "@needy/shared";
import type { DbPool } from "../db.js";

/** ── SOS persistence ───────────────────────────────────────────────────────
 *  An SOS alert MUST outlive the socket that raised it. The button used to be local
 *  component state: pressing it notified nobody and left no record, so nothing could be
 *  followed up, audited, or handed to an operator after the fact. Alerts are therefore
 *  durable and append-mostly — `cancel` records a stand-down rather than deleting the row,
 *  because "there was an alarm and it was withdrawn" is itself safety-relevant history. */
export interface SosRepository {
  create(alert: SosAlert): Promise<SosAlert>;
  get(alertId: string): Promise<SosAlert | null>;
  setStatus(alertId: string, status: SosStatus, at: number): Promise<SosAlert | null>;
  /** Live (non-resolved, non-cancelled) alerts for a task — surfaced in the snapshot so a
   *  reconnecting client still sees that an alarm is active. */
  activeForTask(taskId: string): Promise<SosAlert[]>;
}

// ── in-memory ────────────────────────────────────────────────────────────────

export function createInMemorySosRepo(): SosRepository {
  const byId = new Map<string, SosAlert>();
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
      return [...byId.values()].filter(
        (a) =>
          a.taskId === taskId && a.status !== "resolved" && a.status !== "cancelled",
      );
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
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function createPgSosRepo(pool: DbPool): SosRepository {
  return {
    async create(alert) {
      await pool.query(
        `INSERT INTO sos_alerts
           (id, task_id, raised_by, kind, status, at_lat, at_lng, note, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          alert.id,
          alert.taskId,
          alert.raisedBy,
          alert.kind,
          alert.status,
          alert.at?.lat ?? null,
          alert.at?.lng ?? null,
          alert.note,
          alert.createdAt,
          alert.updatedAt,
        ],
      );
      return alert;
    },
    async get(alertId) {
      const { rows } = await pool.query<SosRow>(
        `SELECT * FROM sos_alerts WHERE id = $1`,
        [alertId],
      );
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
  };
}
