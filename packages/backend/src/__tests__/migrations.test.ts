import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { MIGRATIONS, migrate, pendingMigrations } from "../migrations.js";

/** ── Migration runner, against REAL Postgres ───────────────────────────────
 *  pg-mem cannot host these tests: they turn on `pg_advisory_lock`, transactional DDL, and a
 *  real `schema_migrations` round-trip, none of which pg-mem implements. Testing the runner
 *  against a fake would only prove the fake agrees with itself — and the concurrency behaviour
 *  is the entire reason this runner exists.
 *
 *  Each test gets its own throwaway database so the ledger starts genuinely empty. Reusing one
 *  database would make the tests order-dependent: whichever ran first would apply the
 *  migrations and every later test would see "up to date" and assert nothing.
 */

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://needy:needy@localhost:5432/needy";

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const created: string[] = [];
let admin: pg.Pool;

async function freshDb(label: string): Promise<pg.Pool> {
  // CREATE DATABASE cannot run inside a transaction or be parameterised, hence the
  // interpolation; `label` is a literal from this file and the pid, never user input.
  // Hyphens would need quoting, so they are normalised away rather than quoted — an unquoted
  // `needy_mig_lock-release_123` is a syntax error, which is a confusing way for a test to fail.
  const name = `needy_mig_${label.replace(/[^a-z0-9_]/gi, "_")}_${process.pid}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  created.push(name);
  return new pg.Pool({ connectionString: urlFor(name) });
}

const silent = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  // Fail loudly and early if Postgres isn't up, rather than surfacing as a confusing timeout
  // inside the first test.
  await admin.query("SELECT 1");
});

afterAll(async () => {
  for (const name of created) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  }
  await admin.end();
});

describe("versioned migration runner", () => {
  it("applies every migration on a fresh database and records them in the ledger", async () => {
    const pool = await freshDb("fresh");
    try {
      const applied = await migrate(pool, silent);
      expect(applied).toEqual(MIGRATIONS.map((m) => m.id));

      const { rows } = await pool.query<{ id: number; name: string; applied_at: string }>(
        "SELECT id, name, applied_at FROM schema_migrations ORDER BY id",
      );
      expect(rows.map((r) => Number(r.id))).toEqual(MIGRATIONS.map((m) => m.id));
      expect(rows[0]?.name).toBe("baseline-schema");
      expect(Number(rows[0]?.applied_at)).toBeGreaterThan(0);

      // The baseline is only meaningful if it actually produced the schema.
      const { rows: tables } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const names = tables.map((t) => t.table_name);
      for (const expected of ["users", "sessions", "tasks", "messages", "helpers", "sos_alerts"]) {
        expect(names).toContain(expected);
      }
    } finally {
      await pool.end();
    }
  });

  it("is a no-op on the second run — the ledger, not the DDL, decides", async () => {
    const pool = await freshDb("idempotent");
    try {
      await migrate(pool, silent);
      // If this returned ids again it would mean the runner re-applies work, which is the whole
      // failure mode a non-idempotent future migration would turn into data corruption.
      expect(await migrate(pool, silent)).toEqual([]);
      const { rows } = await pool.query("SELECT id FROM schema_migrations");
      expect(rows).toHaveLength(MIGRATIONS.length);
    } finally {
      await pool.end();
    }
  });

  it("serialises concurrent migrators so a rolling deploy applies each migration exactly once", async () => {
    const pool = await freshDb("concurrent");
    try {
      // Five simultaneous boots against one empty database — the scenario that made the old
      // "run the DDL every time" approach raise duplicate-table errors in the losers.
      const results = await Promise.all(
        Array.from({ length: 5 }, () => migrate(pool, silent)),
      );

      // Exactly one migrator did the work; the rest waited on the advisory lock and then found
      // the ledger already populated.
      const didWork = results.filter((r) => r.length > 0);
      expect(didWork).toHaveLength(1);
      expect(didWork[0]).toEqual(MIGRATIONS.map((m) => m.id));

      const { rows } = await pool.query("SELECT id FROM schema_migrations");
      expect(rows).toHaveLength(MIGRATIONS.length);
    } finally {
      await pool.end();
    }
  });

  it("releases the advisory lock, so a later boot is not wedged by an earlier one", async () => {
    const pool = await freshDb("lock-release");
    try {
      await migrate(pool, silent);
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM pg_locks WHERE locktype = 'advisory'`,
      );
      // A leaked lock would not fail any assertion above — it would silently block the NEXT
      // deploy for as long as the connection lived. That is the failure worth a test.
      expect(Number(rows[0]!.count)).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("reports pending migrations without applying them", async () => {
    const pool = await freshDb("pending");
    try {
      expect((await pendingMigrations(pool)).map((m) => m.id)).toEqual(
        MIGRATIONS.map((m) => m.id),
      );
      // Still pending: asking must not have applied anything.
      expect((await pendingMigrations(pool)).map((m) => m.id)).toEqual(
        MIGRATIONS.map((m) => m.id),
      );

      await migrate(pool, silent);
      expect(await pendingMigrations(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("rolls back the whole migration and records nothing when one statement fails", async () => {
    const pool = await freshDb("failure");
    try {
      // A good statement followed by a bad one, driven through the REAL runner. Without the
      // surrounding transaction the CREATE TABLE would persist and the schema would sit
      // silently half-migrated; without the ledger insert being inside that same transaction,
      // the migration would be marked applied and never retried.
      await expect(
        migrate(pool, silent, [
          {
            id: 9001,
            name: "deliberately-broken",
            statements: [
              "CREATE TABLE mig_atomicity_probe (id TEXT PRIMARY KEY)",
              "THIS IS NOT VALID SQL",
            ],
          },
        ]),
      ).rejects.toThrow(/migration 9001 \(deliberately-broken\) failed/);

      const { rows: tables } = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'mig_atomicity_probe'`,
      );
      expect(tables).toHaveLength(0);

      const { rows: ledger } = await pool.query(
        "SELECT id FROM schema_migrations WHERE id = 9001",
      );
      expect(ledger).toHaveLength(0);

      // And the lock must still have been released, or the failure would wedge every retry.
      const { rows: locks } = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM pg_locks WHERE locktype = 'advisory'`,
      );
      expect(Number(locks[0]!.count)).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("keeps a failed migration pending so the next boot retries it", async () => {
    const pool = await freshDb("retry");
    try {
      const flaky = (sql: string) => [
        { id: 1, name: "baseline-schema", statements: MIGRATIONS[0]!.statements },
        { id: 9002, name: "flaky", statements: [sql] },
      ];
      await expect(migrate(pool, silent, flaky("NOT SQL AT ALL"))).rejects.toThrow();

      // The baseline committed (it is a separate transaction), but 9002 did not — so a corrected
      // deploy applies only the outstanding one.
      const applied = await migrate(pool, silent, flaky("CREATE TABLE mig_retry_ok (id TEXT)"));
      expect(applied).toEqual([9002]);
    } finally {
      await pool.end();
    }
  });
});
