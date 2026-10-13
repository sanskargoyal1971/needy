import type { DbPool } from "../db.js";
import type { Session, User } from "./types.js";

/** Persistence for identity. Same interface-with-two-implementations pattern as the task/
 *  message repos, so auth runs on in-memory in tests/dev and Postgres when configured. */
export interface UserRepository {
  getById(id: string): Promise<User | null>;
  getByPhone(phone: string): Promise<User | null>;
  /** Staff sign-in. Case-insensitive, matching the unique index on `lower(username)` — a
   *  console account reached as `Needy_Admin` and `needy_admin` must be one account, not two
   *  depending on how it was typed. */
  getByUsername(username: string): Promise<User | null>;
  create(user: User): Promise<User>;
  update(id: string, patch: Partial<User>): Promise<User>;

  /**
   * The password hash, on its own, by its own method.
   *
   * Deliberately NOT a field on `User`. `User` is the object that flows through `publicUser`
   * to `/auth/me` and into every admin view, and today's `handoffOtpHash` incident is what a
   * secret riding a widely-serialised type looks like when it eventually escapes: the sanitiser
   * at one boundary was correct, and the other three boundaries had simply never been
   * considered. A credential that is unreachable except through a method named for it cannot
   * leak by being forgotten about.
   *
   * Null means the account has no password, which is the normal state for every account that
   * predates this and for anyone who never sets one.
   */
  getPasswordHash(userId: string): Promise<string | null>;

  /** Set or clear the password. `null` removes it, leaving the account OTP-only.
   *  `setBy` is the admin who issued a temporary one, or null when the holder set it. */
  setPasswordHash(
    userId: string,
    hash: string | null,
    at: number,
    setBy?: string | null,
  ): Promise<void>;
}

export interface SessionRepository {
  create(session: Session): Promise<Session>;
  getByHash(hash: string): Promise<Session | null>;
  /** Revoke one session. Resolves `true` only for the call that actually flipped it, so two
   *  concurrent rotations of the same refresh token cannot both proceed. */
  revoke(id: string, at: number): Promise<boolean>;
  revokeAllForUser(userId: string, at: number): Promise<void>;
}

// ── in-memory ────────────────────────────────────────────────────────────────

/** The in-memory repo additionally exposes `all()`.
 *
 *  Not on `UserRepository` itself: that interface is the request path's view, and a `list()`
 *  there would be an open invitation to scan the users table from a route handler. The admin
 *  surface needs enumeration and gets it through `AdminUserQueries`, whose in-memory
 *  implementation is backed by this accessor. Keeping it off the shared interface is what
 *  stops a full-table read becoming reachable from an ordinary endpoint. */
export type InMemoryUserRepository = UserRepository & { all(): User[] };

export function createInMemoryUserRepo(): InMemoryUserRepository {
  const byId = new Map<string, User>();
  const byPhone = new Map<string, string>();
  /** Separate from the user records for the same reason the column is separate from `User`:
   *  nothing that enumerates users should be able to hand out credentials by accident. */
  const passwordHashes = new Map<string, string>();
  return {
    all() {
      return [...byId.values()];
    },
    async getById(id) {
      return byId.get(id) ?? null;
    },
    async getByPhone(phone) {
      const id = byPhone.get(phone);
      return id ? (byId.get(id) ?? null) : null;
    },
    async getByUsername(username) {
      const wanted = username.toLowerCase();
      return [...byId.values()].find((u) => u.username?.toLowerCase() === wanted) ?? null;
    },
    async create(user) {
      byId.set(user.id, user);
      byPhone.set(user.phone, user.id);
      return user;
    },
    async getPasswordHash(userId) {
      return passwordHashes.get(userId) ?? null;
    },
    async setPasswordHash(userId, hash, at, setBy = null) {
      const user = byId.get(userId);
      if (!user) throw new Error(`user not found: ${userId}`);
      if (hash == null) passwordHashes.delete(userId);
      else passwordHashes.set(userId, hash);
      byId.set(userId, {
        ...user,
        passwordSetAt: hash == null ? null : at,
        passwordSetBy: hash == null ? null : setBy,
        updatedAt: at,
      });
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
      if (!s || s.revokedAt != null) return false;
      byId.set(id, { ...s, revokedAt: at });
      return true;
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
  onboarding_status: string | null;
  /** `pg` hands back a JS Date for a DATE column. Normalised to `YYYY-MM-DD` below. */
  date_of_birth: Date | string | null;
  gender: string | null;
  area_label: string | null;
  area_lat: number | string | null;
  area_lng: number | string | null;
  rejection_reason: string | null;
  blocked_at: number | string | null;
  reviewed_by: string | null;
  reviewed_at: number | string | null;
  submitted_at: number | string | null;
  password_set_at: number | string | null;
  password_set_by: string | null;
  username: string | null;
}

const numOrNull = (v: number | string | null | undefined): number | null =>
  v == null ? null : Number(v);

/**
 * A DATE column arrives as a JS `Date` at local midnight. `toISOString()` on that shifts the
 * calendar day backwards for anyone east of UTC — a user born on the 1st reads as the 31st of
 * the previous month, which changes their age band on exactly the boundary the matrix cares
 * about. Formatting from the local getters keeps the day the database stored.
 */
function toIsoDate(v: Date | string | null): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, "0");
  const d = String(v.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
    // `?? "draft"` covers a row read through a connection that predates migration 3 in tests
    // that stub the pool; on a migrated database the column is NOT NULL with a default.
    onboardingStatus: (r.onboarding_status ?? "draft") as User["onboardingStatus"],
    dateOfBirth: toIsoDate(r.date_of_birth ?? null),
    gender: (r.gender ?? null) as User["gender"],
    areaLabel: r.area_label ?? null,
    areaLat: numOrNull(r.area_lat),
    areaLng: numOrNull(r.area_lng),
    rejectionReason: r.rejection_reason ?? null,
    blockedAt: numOrNull(r.blocked_at),
    reviewedBy: r.reviewed_by ?? null,
    reviewedAt: numOrNull(r.reviewed_at),
    submittedAt: numOrNull(r.submitted_at),
    // The hash column is read by `SELECT *` and deliberately NOT mapped here: `User` must not
    // be able to carry it, whatever the query returns.
    passwordSetAt: numOrNull(r.password_set_at),
    passwordSetBy: r.password_set_by ?? null,
    username: r.username ?? null,
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
    async getByUsername(username) {
      const { rows } = await pool.query<UserRow>(
        `SELECT * FROM users WHERE lower(username) = lower($1)`,
        [username],
      );
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async create(user) {
      await pool.query(
        `INSERT INTO users (id, phone, email, display_name, role, kyc_status, created_at, updated_at,
                            onboarding_status, date_of_birth, gender, area_label, area_lat, area_lng,
                            rejection_reason, blocked_at, reviewed_by, reviewed_at, submitted_at,
                            username)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          user.id,
          user.phone,
          user.email,
          user.displayName,
          user.role,
          user.kycStatus,
          user.createdAt,
          user.updatedAt,
          user.onboardingStatus,
          user.dateOfBirth,
          user.gender,
          user.areaLabel,
          user.areaLat,
          user.areaLng,
          user.rejectionReason,
          user.blockedAt,
          user.reviewedBy,
          user.reviewedAt,
          user.submittedAt,
          user.username,
        ],
      );
      return user;
    },
    async update(id, patch) {
      const existing = await this.getById(id);
      if (!existing) throw new Error(`user not found: ${id}`);
      const next: User = { ...existing, ...patch, id: existing.id };
      await pool.query(
        `UPDATE users SET phone=$2, email=$3, display_name=$4, role=$5, kyc_status=$6, updated_at=$7,
                          onboarding_status=$8, date_of_birth=$9, gender=$10, area_label=$11,
                          area_lat=$12, area_lng=$13, rejection_reason=$14, blocked_at=$15,
                          reviewed_by=$16, reviewed_at=$17, submitted_at=$18, username=$19
         WHERE id=$1`,
        [
          next.id,
          next.phone,
          next.email,
          next.displayName,
          next.role,
          next.kycStatus,
          next.updatedAt,
          next.onboardingStatus,
          next.dateOfBirth,
          next.gender,
          next.areaLabel,
          next.areaLat,
          next.areaLng,
          next.rejectionReason,
          next.blockedAt,
          next.reviewedBy,
          next.reviewedAt,
          next.submittedAt,
          next.username,
        ],
      );
      return next;
    },
    async getPasswordHash(userId) {
      const { rows } = await pool.query<{ password_hash: string | null }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [userId],
      );
      return rows[0]?.password_hash ?? null;
    },
    async setPasswordHash(userId, hash, at, setBy = null) {
      // A targeted UPDATE rather than a read-modify-write through `update()`: that path
      // rewrites every column from a snapshot it read earlier, so a password change would
      // clobber any concurrent edit to the rest of the row, and vice versa.
      const { rowCount } = await pool.query(
        // Every parameter inside a CASE is cast explicitly. Postgres infers the result type of
        // a CASE from its branches, and `NULL` tells it nothing — so an untyped `$3` was
        // inferred as text and the statement failed with "column password_set_at is of type
        // bigint but expression is of type text". It only fired on the Postgres path, which is
        // why the in-memory tests were green.
        `UPDATE users
            SET password_hash = $2::text,
                password_set_at = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::bigint END,
                password_set_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $4::text END,
                updated_at = $3::bigint
          WHERE id = $1`,
        [userId, hash, at, setBy],
      );
      if (rowCount === 0) throw new Error(`user not found: ${userId}`);
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
        [
          session.id,
          session.userId,
          session.refreshTokenHash,
          session.userAgent,
          session.createdAt,
          session.expiresAt,
          session.revokedAt,
        ],
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
      const res = await pool.query(
        `UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
        [id, at],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async revokeAllForUser(userId, at) {
      await pool.query(
        `UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId, at],
      );
    },
  };
}
