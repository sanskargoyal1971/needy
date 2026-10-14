import pg from "pg";
import { migrate, type Migration } from "../migrations.js";

/** ── Throwaway Postgres databases for tests ────────────────────────────────
 *  Extracted from migrations.test.ts, which had this inline, once a second test needed a
 *  real database.
 *
 *  Why real Postgres rather than pg-mem: the repos under test now depend on behaviour pg-mem
 *  does not implement — `ON CONFLICT ... DO UPDATE ... RETURNING`, `jsonb`, partial indexes,
 *  advisory locks and transactional DDL. A fake that silently accepts different SQL only
 *  proves the fake agrees with itself, and the failure mode is a test suite that passes while
 *  production throws.
 *
 *  Each caller gets its own database so the migration ledger starts genuinely empty; sharing
 *  one would make tests order-dependent, with whichever ran first applying the migrations and
 *  every later one asserting against "already up to date".
 */

export const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://needy:needy@localhost:5432/needy";

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export const silentLog = { info: () => {}, warn: () => {} };

/** Tracks every database created so `dropAll` can clean up even if a test threw. */
export class PgHarness {
  private admin: pg.Pool | null = null;
  private readonly created: string[] = [];
  private readonly pools: pg.Pool[] = [];

  async connect(): Promise<void> {
    this.admin = new pg.Pool({ connectionString: ADMIN_URL });
    // Fail loudly and early if Postgres isn't up, rather than surfacing as a confusing
    // timeout inside the first test.
    await this.admin.query("SELECT 1");
  }

  /** A fresh database with every migration applied — or only `list`, so a test can put rows
   *  in place BEFORE a data migration and then watch what it does to them. */
  async freshDb(label: string, list?: readonly Migration[]): Promise<pg.Pool> {
    if (!this.admin) throw new Error("call connect() first");
    // CREATE DATABASE cannot run inside a transaction or be parameterised, hence the
    // interpolation; `label` is a literal from the calling test plus the pid, never user
    // input. Hyphens are normalised away rather than quoted — an unquoted `a-b` is a syntax
    // error, which is a confusing way for a test to fail.
    const name = `needy_t_${label.replace(/[^a-z0-9_]/gi, "_")}_${process.pid}`;
    await this.admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await this.admin.query(`CREATE DATABASE ${name}`);
    this.created.push(name);
    const pool = new pg.Pool({ connectionString: urlFor(name) });
    this.pools.push(pool);
    await migrate(pool, silentLog, list);
    return pool;
  }

  async dropAll(): Promise<void> {
    // Pools must close before DROP DATABASE: an open connection makes the drop hang, and
    // WITH (FORCE) is the belt-and-braces for a connection that outlived its pool.
    for (const p of this.pools) await p.end().catch(() => undefined);
    for (const name of this.created) {
      await this.admin
        ?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        .catch(() => undefined);
    }
    await this.admin?.end().catch(() => undefined);
  }
}
