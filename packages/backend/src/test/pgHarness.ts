import pg from "pg";
import { backfillUserPii } from "../auth/userPii.js";
import { RUNTIME_ROLE_SETTING } from "../dbRoles.js";
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

function urlFor(dbName: string, as?: { user: string; password: string }): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  if (as) {
    u.username = as.user;
    u.password = as.password;
  }
  return u.toString();
}

/** Throwaway login password for the per-test runtime roles. Not a secret: the role exists only
 *  on a local test cluster, for the length of one test file, and is dropped by `dropAll`. */
const TEST_RUNTIME_PASSWORD = "needy-test-runtime";

export const silentLog = { info: () => {}, warn: () => {} };

/** Tracks every database created so `dropAll` can clean up even if a test threw. */
export class PgHarness {
  private admin: pg.Pool | null = null;
  private readonly created: string[] = [];
  private readonly pools: pg.Pool[] = [];
  private readonly roles: string[] = [];

  async connect(): Promise<void> {
    this.admin = new pg.Pool({ connectionString: ADMIN_URL });
    // Fail loudly and early if Postgres isn't up, rather than surfacing as a confusing
    // timeout inside the first test.
    await this.admin.query("SELECT 1");
  }

  /** A fresh database with every migration applied — or only `list`, so a test can put rows
   *  in place BEFORE a data migration and then watch what it does to them. */
  async freshDb(label: string, list?: readonly Migration[]): Promise<pg.Pool> {
    return (await this.createDb(label, list)).pool;
  }

  /**
   * A fresh, fully migrated database served the way production is: `owner` is the role that
   * ran the migrations (the harness's admin user), `runtime` connects as a separate login role
   * that migration 14 granted to. Use `runtime` for anything the app does at request time —
   * the point of these tests is what that role is refused.
   */
  async freshDbWithRuntimeRole(
    label: string,
  ): Promise<{ owner: pg.Pool; runtime: pg.Pool; role: string }> {
    if (!this.admin) throw new Error("call connect() first");
    // Roles are cluster-wide, unlike databases, so the pid keeps parallel test files apart.
    const role = `needy_t_rt_${label.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}_${process.pid}`;
    await this.admin.query(`DROP ROLE IF EXISTS ${role}`);
    await this.admin.query(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${TEST_RUNTIME_PASSWORD}'`,
    );
    this.roles.push(role);
    const { pool: owner, name } = await this.createDb(label, undefined, role);
    const runtime = new pg.Pool({
      connectionString: urlFor(name, { user: role, password: TEST_RUNTIME_PASSWORD }),
    });
    this.pools.push(runtime);
    return { owner, runtime, role };
  }

  private async createDb(
    label: string,
    list?: readonly Migration[],
    runtimeRole?: string,
  ): Promise<{ pool: pg.Pool; name: string }> {
    if (!this.admin) throw new Error("call connect() first");
    // CREATE DATABASE cannot run inside a transaction or be parameterised, hence the
    // interpolation; `label` is a literal from the calling test plus the pid, never user
    // input. Hyphens are normalised away rather than quoted — an unquoted `a-b` is a syntax
    // error, which is a confusing way for a test to fail.
    const name = `needy_t_${label.replace(/[^a-z0-9_]/gi, "_")}_${process.pid}`;
    await this.admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await this.admin.query(`CREATE DATABASE ${name}`);
    this.created.push(name);
    // The same session setting the boot path's owner pool carries (db.ts `createPool`), so
    // migration 14 grants to the runtime role exactly as it would in production.
    const pool = new pg.Pool({
      connectionString: urlFor(name),
      ...(runtimeRole ? { options: `-c ${RUNTIME_ROLE_SETTING}=${runtimeRole}` } : {}),
    });
    this.pools.push(pool);
    await migrate(pool, silentLog, list);
    // The boot path seals personal data straight after migrating, so a fully migrated test
    // database does too — otherwise the seed row migration 2 inserts would sit in the clear
    // here and nowhere else. Skipped for a partial list: before migration 12 there are no
    // sealed columns to fill, and a test stopping short of it is testing the earlier schema.
    if (!list) await backfillUserPii(pool, silentLog);
    return { pool, name };
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
    // After the databases: a role cannot be dropped while it holds privileges in one, and
    // dropping the database is what removes them.
    for (const role of this.roles) {
      await this.admin?.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    await this.admin?.end().catch(() => undefined);
  }
}
