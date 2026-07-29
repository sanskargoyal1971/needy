import pg from "pg";
import type { MatchedHelper } from "@needy/shared";

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
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  photo_url    TEXT NOT NULL DEFAULT '',
  rating       DOUBLE PRECISION NOT NULL DEFAULT 0,
  helped_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  helper_id    TEXT,
  category     TEXT NOT NULL,
  state        TEXT NOT NULL,
  origin_lat   DOUBLE PRECISION NOT NULL,
  origin_lng   DOUBLE PRECISION NOT NULL,
  title        TEXT NOT NULL,
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
`;

export function createPool(databaseUrl: string): DbPool {
  return new Pool({ connectionString: databaseUrl });
}

export async function runMigrations(pool: DbPool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

/** Upsert seed helper profiles (dev stand-in for a KYC-backed profile service). */
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
