import type { DbPool } from "../db.js";
import type { Session, User } from "./types.js";

/** Persistence for identity. Same interface-with-two-implementations pattern as the task/
 *  message repos, so auth runs on in-memory in tests/dev and Postgres when configured. */
export interface UserRepository {
  getById(id: string): Promise<User | null>;
  getByPhone(phone: string): Promise<User | null>;
  create(user: User): Promise<User>;
  update(id: string, patch: Partial<User>): Promise<User>;
}

export interface SessionRepository {
  create(session: Session): Promise<Session>;
  getByHash(hash: string): Promise<Session | null>;
  revoke(id: string, at: number): Promise<void>;
  revokeAllForUser(userId: string, at: number): Promise<void>;
}

// ── in-memory ────────────────────────────────────────────────────────────────

export function createInMemoryUserRepo(): UserRepository {
  const byId = new Map<string, User>();
  const byPhone = new Map<string, string>();
  return {
    async getById(id) {
      return byId.get(id) ?? null;
    },
    async getByPhone(phone) {
      const id = byPhone.get(phone);
      return id ? (byId.get(id) ?? null) : null;
    },
    async create(user) {
      byId.set(user.id, user);
      byPhone.set(user.phone, user.id);
      return user;
    },
    async update(id, patch) {
      const existing = byId.get(id);
      if (!existing) throw new Error(`user not found: ${id}`);
      const next = { ...existing, ...patch, id: existing.id };
      byId.set(id, next);
      byPhone.set(next.phone, id);
      return next;
    },
  };
}

export function createInMemorySessionRepo(): SessionRepository {
  const byId = new Map<string, Session>();
  const byHash = new Map<string, string>();
  return {
    async create(session) {
      byId.set(session.id, session);
      byHash.set(session.refreshTokenHash, session.id);
      return session;
    },
    async getByHash(hash) {
      const id = byHash.get(hash);
      return id ? (byId.get(id) ?? null) : null;
    },
    async revoke(id, at) {
      const s = byId.get(id);
      if (s && s.revokedAt == null) byId.set(id, { ...s, revokedAt: at });
    },
    async revokeAllForUser(userId, at) {
      for (const [id, s] of byId) {
        if (s.userId === userId && s.revokedAt == null) byId.set(id, { ...s, revokedAt: at });
      }
    },
  };
}

// ── postgres ─────────────────────────────────────────────────────────────────

interface UserRow {
  id: string;
  phone: string;
  email: string | null;
  display_name: string;
  role: string;
  kyc_status: string;
  created_at: number | string;
  updated_at: number | string;
}
function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    phone: r.phone,
    email: r.email,
    displayName: r.display_name,
    role: r.role as User["role"],
    kycStatus: r.kyc_status as User["kycStatus"],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function createPgUserRepo(pool: DbPool): UserRepository {
  return {
    async getById(id) {
      const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async getByPhone(phone) {
      const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE phone = $1`, [phone]);
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async create(user) {
      await pool.query(
        `INSERT INTO users (id, phone, email, display_name, role, kyc_status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [user.id, user.phone, user.email, user.displayName, user.role, user.kycStatus, user.createdAt, user.updatedAt],
      );
      return user;
    },
    async update(id, patch) {
      const existing = await this.getById(id);
      if (!existing) throw new Error(`user not found: ${id}`);
      const next: User = { ...existing, ...patch, id: existing.id };
      await pool.query(
        `UPDATE users SET phone=$2, email=$3, display_name=$4, role=$5, kyc_status=$6, updated_at=$7 WHERE id=$1`,
        [next.id, next.phone, next.email, next.displayName, next.role, next.kycStatus, next.updatedAt],
      );
      return next;
    },
  };
}

interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  user_agent: string;
  created_at: number | string;
  expires_at: number | string;
  revoked_at: number | string | null;
}
function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    userId: r.user_id,
    refreshTokenHash: r.refresh_token_hash,
    userAgent: r.user_agent,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
  };
}

export function createPgSessionRepo(pool: DbPool): SessionRepository {
  return {
    async create(session) {
      await pool.query(
        `INSERT INTO sessions (id, user_id, refresh_token_hash, user_agent, created_at, expires_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [session.id, session.userId, session.refreshTokenHash, session.userAgent, session.createdAt, session.expiresAt, session.revokedAt],
      );
      return session;
    },
    async getByHash(hash) {
      const { rows } = await pool.query<SessionRow>(
        `SELECT * FROM sessions WHERE refresh_token_hash = $1`,
        [hash],
      );
      return rows[0] ? rowToSession(rows[0]) : null;
    },
    async revoke(id, at) {
      await pool.query(`UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, at]);
    },
    async revokeAllForUser(userId, at) {
      await pool.query(`UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, at]);
    },
  };
}
