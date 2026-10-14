import pg from "pg";
import type { MatchedHelper } from "@needy/shared";
import { RUNTIME_ROLE_SETTING } from "./dbRoles.js";
import { logger } from "./logger.js";

const { Pool } = pg;
export type DbPool = pg.Pool;

/** Durable schema (§2.5). Timestamps are epoch-ms BIGINTs to match the app's `deps.now()`
 *  clock exactly (no timezone drift). Idempotent so it can run on every boot. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  phone        TEXT UNIQUE NOT NULL,
  email        TEXT,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'requester',
  kyc_status   TEXT NOT NULL DEFAULT 'unverified',
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

-- Refresh-token sessions. We store only a HASH of each refresh token so a DB leak
-- never exposes a usable credential; revocation flips revoked_at.
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  refresh_token_hash TEXT UNIQUE NOT NULL,
  user_agent         TEXT NOT NULL DEFAULT '',
  created_at         BIGINT NOT NULL,
  expires_at         BIGINT NOT NULL,
  revoked_at         BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS helpers (
  id             TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  photo_url      TEXT NOT NULL DEFAULT '',
  bio            TEXT NOT NULL DEFAULT '',
  rating         DOUBLE PRECISION NOT NULL DEFAULT 0,
  helped_count   INTEGER NOT NULL DEFAULT 0,
  total_earnings INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS helper_applications (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  display_name TEXT NOT NULL,
  phone        TEXT NOT NULL,
  aadhaar_last4 TEXT NOT NULL,
  experience   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  reviewed_by  TEXT,
  review_note  TEXT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applications_user ON helper_applications (user_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON helper_applications (status);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  helper_id    TEXT,
  category     TEXT NOT NULL,
  state        TEXT NOT NULL,
  origin_lat   DOUBLE PRECISION NOT NULL,
  origin_lng   DOUBLE PRECISION NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks (requester_id);
CREATE INDEX IF NOT EXISTS idx_tasks_helper ON tasks (helper_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  sender_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  status     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages (task_id, created_at);

-- Durable SOS alerts. Rows are never deleted: a withdrawn alarm is recorded as
-- status='cancelled' because "there was an alarm and it was stood down" is itself
-- safety-relevant history an operator may need to review.
CREATE TABLE IF NOT EXISTS sos_alerts (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  raised_by  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  at_lat     DOUBLE PRECISION,
  at_lng     DOUBLE PRECISION,
  note       TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sos_task ON sos_alerts (task_id, created_at);
-- Partial index: the operator surface only ever queries LIVE alerts.
CREATE INDEX IF NOT EXISTS idx_sos_live ON sos_alerts (created_at)
  WHERE status NOT IN ('resolved','cancelled');
`;

/** Constraints and foreign keys applied AFTER the base tables (audit: the schema had no FKs
 *  at all, so a message could reference a task that never existed and an orphaned session
 *  could outlive its user).
 *
 *  Kept separate from SCHEMA_SQL and applied defensively for two reasons: `ADD CONSTRAINT`
 *  has no `IF NOT EXISTS` in Postgres 16, and on an existing database with dirty rows a
 *  constraint can legitimately fail to validate — in which case we want a loud warning and a
 *  running app, not a boot loop. Each statement is independent so one failure doesn't block
 *  the rest.
 *
 *  ON DELETE: sessions/sos cascade (meaningless without their parent), while tasks.helper_id
 *  is SET NULL — losing a helper account must not delete the requester's task history. */
export const CONSTRAINTS_SQL: readonly string[] = [
  `ALTER TABLE sessions ADD CONSTRAINT fk_sessions_user
     FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
  `ALTER TABLE messages ADD CONSTRAINT fk_messages_task
     FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE`,
  `ALTER TABLE sos_alerts ADD CONSTRAINT fk_sos_task
     FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE`,
  `ALTER TABLE tasks ADD CONSTRAINT chk_tasks_state CHECK (state IN
     ('searching','matched','verifying','en-route','arrived','in-progress','completed','cancelled'))`,
  `ALTER TABLE tasks ADD CONSTRAINT chk_tasks_category CHECK (category IN
     ('errand','companionship','social-service','urgent'))`,
  `ALTER TABLE tasks ADD CONSTRAINT chk_tasks_origin CHECK (
     origin_lat BETWEEN -90 AND 90 AND origin_lng BETWEEN -180 AND 180)`,
  `ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (role IN
     ('requester','helper','both','admin'))`,
  `ALTER TABLE users ADD CONSTRAINT chk_users_kyc CHECK (kyc_status IN
     ('unverified','pending','verified','rejected'))`,
  `ALTER TABLE messages ADD CONSTRAINT chk_messages_status CHECK (status IN
     ('sent','delivered','read'))`,
  `ALTER TABLE sos_alerts ADD CONSTRAINT chk_sos_status CHECK (status IN
     ('raised','acknowledged','resolved','cancelled'))`,
  `ALTER TABLE helper_applications ADD CONSTRAINT fk_applications_user
     FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
  `ALTER TABLE helper_applications ADD CONSTRAINT chk_applications_status CHECK (status IN
     ('pending','approved','rejected'))`,
  `ALTER TABLE helper_applications ADD CONSTRAINT chk_aadhaar_last4 CHECK (
     LENGTH(aadhaar_last4) = 4 AND aadhaar_last4 ~ '^[0-9]{4}$')`,
];

/**
 * `runtimeRole` is set only on the OWNER pool: it names the role migration 14 and the boot-time
 * grant step give privileges to (see dbRoles.ts), as a session setting because a migration is
 * fixed SQL and cannot take a parameter. The caller validates it (`resolveRuntimeRole`) — it
 * travels in the startup options, where a space would split it into a second option.
 */
export function createPool(databaseUrl: string, opts: { runtimeRole?: string } = {}): DbPool {
  return new Pool({
    connectionString: databaseUrl,
    ...(opts.runtimeRole ? { options: `-c ${RUNTIME_ROLE_SETTING}=${opts.runtimeRole}` } : {}),
  });
}

/**
 * Raw one-shot DDL application. **Not the boot path** — production boots through
 * `migrate()` in migrations.ts, which is versioned and advisory-locked.
 *
 * This remains for tests, which run against pg-mem: pg-mem implements neither
 * `pg_advisory_lock` nor a real `schema_migrations` round-trip, so the versioned runner cannot
 * execute there. Tests want "give me these tables and nothing clever" anyway.
 *
 * Because migration 1 is the same `SCHEMA_SQL` baseline, a database set up by either path is
 * identical in shape — the only difference is whether the ledger row exists, and `migrate()`
 * will record it on the next real boot without re-doing any work.
 */
export async function runMigrations(pool: DbPool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await applyConstraints(pool);
}

/**
 * Apply CONSTRAINTS_SQL, tolerating "already exists" (42710 / 42P07) so boots are idempotent.
 * Anything else is logged as a warning and skipped rather than thrown: a pre-existing row
 * that violates a new CHECK is a data problem for an operator to resolve, and it must not
 * take the service down on restart.
 *
 * Uses the app logger, not `console.warn`. An earlier version chose console to keep this module
 * dependency-free for migration tooling, but `logger.ts` imports nothing at all, so there was no
 * dependency to avoid — and the logger REDACTS, which matters because a constraint violation's
 * `detail` can quote the offending row and our rows contain phone numbers.
 *
 * The SQLSTATE is reported as `sqlState`, not `code`: `code` is on the logger's redaction list
 * (it is the OTP field name), so the more obvious key would have logged `[redacted]` and left an
 * operator with a warning that names no cause.
 */
async function applyConstraints(pool: DbPool): Promise<void> {
  for (const sql of CONSTRAINTS_SQL) {
    try {
      await pool.query(sql);
    } catch (err) {
      const sqlState = (err as { code?: string }).code;
      if (sqlState === "42710" || sqlState === "42P07") continue; // already exists — expected
      logger.warn("constraint not applied (existing data may violate it)", {
        sqlState,
        detail: (err as Error).message,
      });
    }
  }
}

/** Upsert seed helper profiles (dev stand-in for a KYC-backed profile service).
 *
 *  `ON CONFLICT DO UPDATE` means this OVERWRITES existing rows, and it used to run on every
 *  single boot — so a deploy would stomp real helper profiles (name, rating, helped count)
 *  with dev fixture data. Callers must now gate this on a dev/test environment; see the
 *  guard in index.ts. */
export async function seedHelperProfiles(
  pool: DbPool,
  seed: Record<string, Omit<MatchedHelper, "etaSeconds">>,
): Promise<void> {
  for (const h of Object.values(seed)) {
    await pool.query(
      `INSERT INTO helpers (id, display_name, photo_url, rating, helped_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         photo_url    = EXCLUDED.photo_url,
         rating       = EXCLUDED.rating,
         helped_count = EXCLUDED.helped_count`,
      [h.id, h.displayName, h.photoUrl, h.rating, h.helpedCount],
    );
  }
}
