import type { DbPool } from "./db.js";
import type { MigrationLog } from "./migrations.js";

/** ── Two database roles ────────────────────────────────────────────────────
 *  The app used to connect as the role that owns the schema. Ownership is the one privilege no
 *  GRANT can take away: the owner of `audit_log` can `DROP RULE audit_log_no_delete`, or simply
 *  `TRUNCATE` (rules do not fire on TRUNCATE), so "append-only" held only as long as nobody
 *  holding the app's credentials decided otherwise. A compromised process, or a well-meaning
 *  "clean up the test rows" script run with the app's `.env`, could erase the trail.
 *
 *  So there are two:
 *   - the OWNER (DATABASE_MIGRATION_URL) runs migrations and the boot-time backfills, and its
 *     pool is closed before the server listens;
 *   - the RUNTIME role (DATABASE_URL) serves traffic. It may read and write ordinary tables but
 *     on the append-only ones it may only SELECT and INSERT, and since it owns nothing it cannot
 *     drop or disable the rules either.
 *
 *  The grants are a privilege policy, not a schema shape, so they are applied on EVERY boot as
 *  well as by migration 14. That is what covers a runtime role created after the migration ran
 *  (the migration skips a role that does not exist yet), and a table added by a later
 *  migration that the default privileges gave the wrong grant to.
 */

/** Tables where history is evidence. The runtime role may add to them and read them, never
 *  change or remove a row. Adding a table here takes effect on the next boot. */
export const APPEND_ONLY_TABLES: readonly string[] = ["audit_log", "abuse_signals"];

/** Tables the runtime role reads and never writes. The migration ledger is the owner's: a
 *  runtime role that could insert into it could mark a migration applied that never ran. Nor
 *  may it move where the audit chain starts (migration 15): every unhashed row it could push
 *  below that line would stop counting as a break. */
export const READ_ONLY_TABLES: readonly string[] = ["schema_migrations", "audit_chain_start"];

/** The session setting that names the runtime role. A setting rather than a literal in the SQL
 *  because the role's name is a deployment choice, and a migration cannot be parameterised. The
 *  owner pool sets it at connect (see `createPool`). */
export const RUNTIME_ROLE_SETTING = "needy.runtime_role";

/** What a Postgres role name may look like here. Narrower than Postgres allows, on purpose: the
 *  name travels in a connection's startup options, where a space or a quote would end it. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const arr = (xs: readonly string[]) => `ARRAY[${xs.map(lit).join(",")}]::text[]`;

/**
 * Grant the runtime role exactly what serving traffic needs, idempotently.
 *
 * Every table's grant is REVOKE ALL and then re-granted, rather than only granted, so a
 * privilege added by hand ("just give the app TRUNCATE for this one fix") does not survive the
 * next boot. Skipped, with a NOTICE, when the setting is empty, when the role does not exist,
 * and when it names the role running this — granting the owner less than it owns does nothing.
 *
 * Migration 14 runs this too, so changing it changes a released migration's text. That is the
 * one case where it is harmless: the boot step re-runs the current version on every database
 * every start, so no database is left on an older policy the way it would be with DDL.
 */
export const RUNTIME_GRANTS_SQL = `
DO $grants$
DECLARE
  r text := nullif(current_setting('${RUNTIME_ROLE_SETTING}', true), '');
  append_only text[] := ${arr(APPEND_ONLY_TABLES)};
  read_only text[] := ${arr(READ_ONLY_TABLES)};
  t record;
BEGIN
  IF r IS NULL THEN
    RAISE NOTICE 'no runtime role configured; grants skipped';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    RAISE NOTICE 'runtime role % does not exist; grants skipped', r;
    RETURN;
  END IF;
  IF r = current_user THEN
    RAISE NOTICE 'runtime role % is the owner; nothing to separate', r;
    RETURN;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
  -- A role that can create tables in the schema could create one it owns and point nothing at
  -- it, which is harmless, or create objects other code then trusts, which is not.
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);

  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t.relname, r);
    IF t.relname = ANY (read_only) THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', t.relname, r);
    ELSIF t.relname = ANY (append_only) THEN
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO %I', t.relname, r);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I', t.relname, r);
    END IF;
  END LOOP;

  -- BIGSERIAL inserts call nextval, which is USAGE on the sequence. Not UPDATE: that is setval,
  -- and a role that could rewind audit_log's sequence could make new rows sort before old ones.
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
  LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I', t.relname, r);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', t.relname, r);
  END LOOP;

  -- Tables a later migration creates. These defaults are the ordinary-table grant; a new
  -- append-only table must also be added to APPEND_ONLY_TABLES, which narrows it on next boot.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', r);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', r);
END
$grants$`;

/**
 * Which role the app serves as. `DATABASE_RUNTIME_ROLE` when set, otherwise the user in
 * DATABASE_URL — they are the same thing, and making an operator say it twice is how the two
 * come to disagree. Throws on a name that would not survive the trip through startup options.
 */
export function resolveRuntimeRole(databaseUrl: string, explicit: string): string {
  let name = explicit.trim();
  if (!name) {
    try {
      name = decodeURIComponent(new URL(databaseUrl).username);
    } catch {
      name = "";
    }
  }
  if (!ROLE_NAME.test(name)) {
    throw new Error(
      "could not determine the runtime database role: set DATABASE_RUNTIME_ROLE, or put a user " +
        "in DATABASE_URL (lowercase letters, digits and underscores)",
    );
  }
  return name;
}

/** Its own advisory key, like the PII backfill's. Not the migration runner's: migrations.ts
 *  imports this module for migration 14, so importing its key back would be a cycle. Every
 *  instance runs `migrate` before this, so a migration and a sync never overlap anyway. */
const GRANTS_LOCK_KEY = 0x6e726f6c; // "nrol"

/** Re-apply the runtime grants. Called on the OWNER pool after `migrate`, every boot.
 *
 *  Under a lock, in a transaction: two instances granting at once can fail with "tuple
 *  concurrently updated", and a REVOKE visible without its GRANT would fail whatever query the
 *  runtime role ran in between. */
export async function syncRuntimeGrants(owner: DbPool, log: MigrationLog): Promise<void> {
  const client = await owner.connect();
  try {
    const { rows } = await client.query<{ role: string | null; present: boolean }>(
      `SELECT nullif(current_setting($1, true), '') AS role,
              EXISTS (SELECT 1 FROM pg_roles
                       WHERE rolname = nullif(current_setting($1, true), '')) AS present`,
      [RUNTIME_ROLE_SETTING],
    );
    const { role, present } = rows[0]!;
    if (!role || !present) {
      // Loud because the server is about to try to connect as this role and fail, and the
      // connection error alone does not say the grants were never made.
      log.warn("runtime database role not found; no grants applied", { role });
      return;
    }
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [GRANTS_LOCK_KEY]);
      await client.query(RUNTIME_GRANTS_SQL);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    log.info("runtime database grants applied", { role });
  } finally {
    client.release();
  }
}

/**
 * What is wrong with the role this pool connects as, for serving traffic. Empty means it is
 * fit: not a superuser, none of CREATEROLE, REPLICATION or BYPASSRLS, owns none of the
 * append-only tables, and can neither UPDATE, DELETE nor TRUNCATE them.
 *
 * The attributes because each is a way round the rest of this check. Before Postgres 16 a
 * CREATEROLE role can grant itself membership in any non-superuser role, the owner included;
 * REPLICATION can stream the whole cluster out, or drive a replication slot; BYPASSRLS voids
 * any row-level policy added later. The init script creates the role without them, and this
 * is what notices when a hand-made role did not.
 *
 * Asked of the database rather than inferred from configuration, because the configuration is
 * what is being checked: two URLs with different user names can still both be superusers.
 */
export async function inspectRuntimeRole(pool: DbPool): Promise<string[]> {
  const { rows } = await pool.query<{
    role: string;
    superuser: boolean;
    createrole: boolean;
    replication: boolean;
    bypassrls: boolean;
    relname: string;
    present: boolean;
    owner: string | null;
    owns: boolean | null;
    can_update: boolean | null;
    can_delete: boolean | null;
    can_truncate: boolean | null;
  }>(
    `SELECT current_user AS role,
            r.rolsuper AS superuser,
            r.rolcreaterole AS createrole,
            r.rolreplication AS replication,
            r.rolbypassrls AS bypassrls,
            t.relname,
            c.oid IS NOT NULL AS present,
            pg_get_userbyid(c.relowner) AS owner,
            pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
            has_table_privilege(c.oid, 'UPDATE') AS can_update,
            has_table_privilege(c.oid, 'DELETE') AS can_delete,
            has_table_privilege(c.oid, 'TRUNCATE') AS can_truncate
       FROM unnest($1::text[]) AS t(relname)
       CROSS JOIN pg_roles r
       LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || quote_ident(t.relname))
      WHERE r.rolname = current_user`,
    [APPEND_ONLY_TABLES],
  );
  const problems: string[] = [];
  const self = rows[0];
  if (self?.superuser) problems.push(`role ${self.role} is a superuser`);
  const attributes = [
    self?.createrole && "CREATEROLE",
    self?.replication && "REPLICATION",
    self?.bypassrls && "BYPASSRLS",
  ].filter(Boolean);
  if (self && attributes.length > 0) problems.push(`role ${self.role} has ${attributes.join("/")}`);
  for (const r of rows) {
    if (!r.present) {
      problems.push(`${r.relname} does not exist (migrations not applied?)`);
      continue;
    }
    if (r.owns) problems.push(`role ${r.role} owns ${r.relname} (owner: ${r.owner})`);
    const can = [
      r.can_update && "UPDATE",
      r.can_delete && "DELETE",
      r.can_truncate && "TRUNCATE",
    ].filter(Boolean);
    if (can.length > 0) problems.push(`role ${r.role} can ${can.join("/")} ${r.relname}`);
  }
  return problems;
}
