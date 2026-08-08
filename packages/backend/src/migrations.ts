import type { DbPool } from "./db.js";
import { CONSTRAINTS_SQL, SCHEMA_SQL } from "./db.js";

/** ── Migrations ────────────────────────────────────────────────────────────
 *  A real versioned migration runner, replacing "execute the whole DDL file on every boot".
 *
 *  What was wrong with the previous approach, concretely:
 *   - No record of what had been applied, so there was no way to write a migration that isn't
 *     idempotent — no `ALTER TABLE … RENAME`, no backfill, no data correction. Every future
 *     schema change would have had to be expressible as `CREATE … IF NOT EXISTS`, which is a
 *     constraint that gets abandoned the first time someone needs to rename a column, usually
 *     by editing the DDL in place and leaving every existing database behind.
 *   - No mutual exclusion. Two instances booting simultaneously (a rolling deploy, or just
 *     `npm run dev` twice) both ran the DDL concurrently; `CREATE TABLE IF NOT EXISTS` is not
 *     atomic against a competing creator and raises a duplicate-table error in the loser.
 *   - No ordering guarantee between the tables and the constraints that reference them.
 *
 *  Design choices, and why:
 *   - Hand-rolled rather than node-pg-migrate/knex. The whole runner is ~80 lines, it needs no
 *     CLI, no config file, and no separate build step, and it keeps `pg` as the only database
 *     dependency. A migration library earns its place when you need generated down-migrations
 *     and a plugin ecosystem; here it would be more moving parts than the thing it runs.
 *   - Migrations are SQL strings in an ordered array in *this file*, not files on disk. The
 *     backend ships as a compiled `dist/` (and inside a container that copies only `dist/`), so
 *     reading `.sql` files at runtime means shipping them too and resolving paths relative to
 *     an ESM module. In-code migrations cannot go missing from a build.
 *   - **No down-migrations.** Deliberate. A rollback that drops a column destroys production
 *     data, and the honest recovery path for a bad migration is a forward fix plus a restore
 *     from backup. Offering `down()` mostly encourages running it.
 */

export interface Migration {
  /** Monotonic. Never renumber or reorder a released migration: the number is the identity. */
  readonly id: number;
  readonly name: string;
  /** Statements applied in order, all inside ONE transaction with the rest of the migration. */
  readonly statements: readonly string[];
  /**
   * Statements whose failure is tolerated, applied after `statements` and OUTSIDE the
   * transaction. This exists for exactly one case: adding a CHECK/FK to a table that may
   * already hold violating rows. Such a constraint legitimately cannot be validated, and the
   * right response is a loud warning for an operator, not a service that refuses to boot.
   */
  readonly tolerant?: readonly string[];
}

/**
 * Migration 1 is the *baseline*. Its statements are the original `CREATE TABLE IF NOT EXISTS`
 * DDL, which is what makes adopting this runner safe on the databases that already exist: on a
 * fresh database it creates everything, and on a database that was booted under the old
 * always-run-the-DDL scheme every statement is a no-op and the row simply records that the
 * baseline is present. No manual `INSERT INTO schema_migrations` step, no divergence between
 * "new deploy" and "existing deploy".
 *
 * Everything from here on must be a NEW numbered entry. Editing a released migration's SQL is
 * the one genuinely unrecoverable mistake available here: databases that already ran it will
 * never see the change, and the two will drift silently.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "baseline-schema",
    statements: [SCHEMA_SQL],
    // Constraints are tolerant rather than transactional: see CONSTRAINTS_SQL's own note. On a
    // database with pre-existing dirty rows these are precisely the statements we want to warn
    // about and continue past.
    tolerant: CONSTRAINTS_SQL,
  },
  {
    id: 2,
    name: "pricing-applications-admin",
    statements: [
      // Tasks: add description + price
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0`,
      // Helpers: add bio + earnings
      `ALTER TABLE helpers ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE helpers ADD COLUMN IF NOT EXISTS total_earnings INTEGER NOT NULL DEFAULT 0`,
      // Helper applications table
      `CREATE TABLE IF NOT EXISTS helper_applications (
         id            TEXT PRIMARY KEY,
         user_id       TEXT NOT NULL,
         display_name  TEXT NOT NULL,
         phone         TEXT NOT NULL,
         aadhaar_last4 TEXT NOT NULL,
         experience    TEXT NOT NULL DEFAULT '',
         status        TEXT NOT NULL DEFAULT 'pending',
         reviewed_by   TEXT,
         review_note   TEXT,
         created_at    BIGINT NOT NULL,
         updated_at    BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_applications_user ON helper_applications (user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_applications_status ON helper_applications (status)`,
      // Seed an admin user for the demo (phone +919999999999). ON CONFLICT so it's idempotent.
      `INSERT INTO users (id, phone, email, display_name, role, kyc_status, created_at, updated_at)
       VALUES ('admin-seed', '+919999999999', NULL, 'Admin', 'admin', 'verified', ${Date.now()}, ${Date.now()})
       ON CONFLICT (id) DO NOTHING`,
    ],
    tolerant: [
      `ALTER TABLE helper_applications ADD CONSTRAINT fk_applications_user
         FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
      `ALTER TABLE helper_applications ADD CONSTRAINT chk_applications_status CHECK (status IN
         ('pending','approved','rejected'))`,
    ],
  },
];

/** Arbitrary but FIXED key. Postgres advisory locks are global per-database and keyed only by
 *  this number, so it must never change and must not collide with another subsystem's lock. */
const MIGRATION_LOCK_KEY = 0x6e656564; // "need"

const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  BIGINT NOT NULL
)`;

export interface MigrationLog {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Apply every migration not yet recorded, in id order.
 *
 * Concurrency: takes a session-level advisory lock first, so a rolling deploy in which five
 * instances boot at once results in one migrator and four waiters that then find nothing to do.
 * The lock is released in a `finally`, and even if the process is killed mid-migration Postgres
 * drops it when the connection dies — a crashed migrator cannot wedge the next boot.
 *
 * Atomicity: each migration's `statements` run in a single transaction *together with* the
 * ledger insert. A migration therefore cannot be recorded as applied unless it actually
 * committed, and cannot half-apply. (Postgres has transactional DDL, which is what makes this
 * work at all — the same pattern is unsafe on MySQL.)
 */
export async function migrate(
  pool: DbPool,
  log: MigrationLog,
  /** Overridable so tests can drive the real runner with a synthetic migration — notably a
   *  deliberately failing one, which cannot be expressed as a released migration. Production
   *  callers always take the default. */
  list: readonly Migration[] = MIGRATIONS,
): Promise<number[]> {
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    // The lock comes FIRST — before even creating the ledger.
    //
    // `CREATE TABLE IF NOT EXISTS` is not atomic against a competing creator: the existence
    // check and the creation are separate steps, so two concurrent callers can both see "absent"
    // and both try to create, and the loser fails with a duplicate-key violation on
    // `pg_type_typname_nsp_index` rather than the friendlier `duplicate_table`. Creating the
    // ledger before taking the lock therefore reintroduced, in the runner's own first statement,
    // precisely the race the runner exists to eliminate. (Found by the concurrency test below,
    // not by reasoning — which is the argument for testing this against real Postgres.)
    //
    // Advisory locks need no table of their own, so there is nothing to bootstrap: the lock is
    // available on an empty database.
    //
    // Blocks until acquired. Waiting is the correct behaviour: the alternative
    // (pg_try_advisory_lock, give up) would let an instance start serving against a schema
    // that is still being changed underneath it.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await client.query(LEDGER_SQL);
      const { rows } = await client.query<{ id: number }>("SELECT id FROM schema_migrations");
      const done = new Set(rows.map((r) => Number(r.id)));

      for (const m of [...list].sort((a, b) => a.id - b.id)) {
        if (done.has(m.id)) continue;

        await client.query("BEGIN");
        try {
          for (const sql of m.statements) await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3)",
            [m.id, m.name, Date.now()],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          // Rethrow: an unapplied migration means the schema is not what the code expects, and
          // serving traffic against it produces corrupt data rather than a clean failure.
          throw new Error(
            `migration ${m.id} (${m.name}) failed: ${(err as Error).message}`,
            { cause: err },
          );
        }

        // Tolerant statements run after the commit, each on its own, so one unvalidatable
        // constraint neither rolls back the tables nor blocks the constraints after it.
        for (const sql of m.tolerant ?? []) {
          try {
            await client.query(sql);
          } catch (err) {
            const code = (err as { code?: string }).code;
            // 42710 duplicate_object / 42P07 duplicate_table — already present, expected on
            // any database that has booted before.
            if (code === "42710" || code === "42P07") continue;
            log.warn("constraint not applied; existing data may violate it", {
              migration: m.id,
              code,
              detail: (err as Error).message,
            });
          }
        }

        applied.push(m.id);
        log.info("migration applied", { id: m.id, name: m.name });
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }

  if (applied.length === 0) log.info("schema up to date", { migrations: list.length });
  return applied;
}

/**
 * Report pending migrations without applying any. Intended for a deploy pre-check or a
 * readiness probe on a replica that must not itself migrate.
 */
export async function pendingMigrations(pool: DbPool): Promise<Migration[]> {
  // Unlocked `CREATE TABLE IF NOT EXISTS` can race a concurrent creator (see the note in
  // `migrate`). Tolerated here rather than taking the lock: this is an advisory read, and
  // blocking a readiness probe behind an in-progress migration would report the instance as
  // unhealthy for the duration of the deploy. A duplicate-object error just means someone else
  // created the ledger a millisecond earlier — in which case it exists, which is all we wanted.
  await pool.query(LEDGER_SQL).catch((err: { code?: string }) => {
    if (err.code !== "42710" && err.code !== "42P07" && err.code !== "23505") throw err;
  });
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM schema_migrations");
  const done = new Set(rows.map((r) => Number(r.id)));
  return MIGRATIONS.filter((m) => !done.has(m.id)).sort((a, b) => a.id - b.id);
}
