import type { ApplicationStatus, HelperApplication } from "@needy/shared";
import type { DbPool } from "../db.js";

/** Persistence for helper applications. Same interface-with-two-implementations pattern
 *  as every other repository in the codebase. */
export interface HelperApplicationRepository {
  create(application: HelperApplication): Promise<HelperApplication>;
  getById(id: string): Promise<HelperApplication | null>;
  getByUserId(userId: string): Promise<HelperApplication | null>;
  listByStatus(status: ApplicationStatus): Promise<HelperApplication[]>;
  listAll(): Promise<HelperApplication[]>;
  update(id: string, patch: Partial<HelperApplication>): Promise<HelperApplication>;
}

// ── in-memory ──────────────────────────────────────────────────────────────

export function createInMemoryApplicationRepo(): HelperApplicationRepository {
  const byId = new Map<string, HelperApplication>();
  return {
    async create(app) {
      byId.set(app.id, app);
      return app;
    },
    async getById(id) {
      return byId.get(id) ?? null;
    },
    async getByUserId(userId) {
      for (const app of byId.values()) {
        if (app.userId === userId && app.status === "pending") return app;
      }
      return null;
    },
    async listByStatus(status) {
      return [...byId.values()].filter((a) => a.status === status);
    },
    async listAll() {
      return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
    },
    async update(id, patch) {
      const existing = byId.get(id);
      if (!existing) throw new Error(`application not found: ${id}`);
      const next = { ...existing, ...patch, id: existing.id };
      byId.set(id, next);
      return next;
    },
  };
}

// ── postgres ───────────────────────────────────────────────────────────────

interface ApplicationRow {
  id: string;
  user_id: string;
  display_name: string;
  phone: string;
  aadhaar_last4: string;
  experience: string;
  status: string;
  reviewed_by: string | null;
  review_note: string | null;
  created_at: number | string;
  updated_at: number | string;
}

function rowToApp(r: ApplicationRow): HelperApplication {
  return {
    id: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    phone: r.phone,
    aadhaarLast4: r.aadhaar_last4,
    experience: r.experience,
    status: r.status as ApplicationStatus,
    reviewedBy: r.reviewed_by,
    reviewNote: r.review_note,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function createPgApplicationRepo(pool: DbPool): HelperApplicationRepository {
  return {
    async create(app) {
      await pool.query(
        `INSERT INTO helper_applications (id, user_id, display_name, phone, aadhaar_last4, experience, status, reviewed_by, review_note, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          app.id,
          app.userId,
          app.displayName,
          app.phone,
          app.aadhaarLast4,
          app.experience,
          app.status,
          app.reviewedBy,
          app.reviewNote,
          app.createdAt,
          app.updatedAt,
        ],
      );
      return app;
    },
    async getById(id) {
      const { rows } = await pool.query<ApplicationRow>(
        `SELECT * FROM helper_applications WHERE id = $1`,
        [id],
      );
      return rows[0] ? rowToApp(rows[0]) : null;
    },
    async getByUserId(userId) {
      const { rows } = await pool.query<ApplicationRow>(
        `SELECT * FROM helper_applications WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      return rows[0] ? rowToApp(rows[0]) : null;
    },
    async listByStatus(status) {
      const { rows } = await pool.query<ApplicationRow>(
        `SELECT * FROM helper_applications WHERE status = $1 ORDER BY created_at ASC`,
        [status],
      );
      return rows.map(rowToApp);
    },
    async listAll() {
      const { rows } = await pool.query<ApplicationRow>(
        `SELECT * FROM helper_applications ORDER BY created_at DESC`,
      );
      return rows.map(rowToApp);
    },
    async update(id, patch) {
      const existing = await this.getById(id);
      if (!existing) throw new Error(`application not found: ${id}`);
      const next: HelperApplication = { ...existing, ...patch, id: existing.id };
      await pool.query(
        `UPDATE helper_applications SET display_name=$2, phone=$3, aadhaar_last4=$4, experience=$5, status=$6, reviewed_by=$7, review_note=$8, updated_at=$9 WHERE id=$1`,
        [
          next.id,
          next.displayName,
          next.phone,
          next.aadhaarLast4,
          next.experience,
          next.status,
          next.reviewedBy,
          next.reviewNote,
          next.updatedAt,
        ],
      );
      return next;
    },
  };
}
