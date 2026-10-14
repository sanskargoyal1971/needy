import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgAuditLogger, readAuditLog } from "../audit/log.js";
import {
  inspectRuntimeRole,
  resolveRuntimeRole,
  RUNTIME_ROLE_SETTING,
  syncRuntimeGrants,
} from "../dbRoles.js";
import { migrate } from "../migrations.js";
import { ADMIN_URL, PgHarness, silentLog } from "../test/pgHarness.js";

/** ── Migration 14: the runtime role ────────────────────────────────────────
 *  The property under test is what the role the app SERVES as is refused. Before this, the app
 *  connected as the owner of audit_log, and an owner can TRUNCATE (rules do not fire on it) or
 *  drop the rules outright — every one of the refusals below succeeded.
 *
 *  Against real Postgres because privileges, ownership and rules are the whole subject; a fake
 *  that does not implement GRANT would pass everything here.
 */

/** Postgres's "insufficient_privilege" (or "must be owner"). Asserted by code, not by message,
 *  so the test does not depend on the server's locale. */
const DENIED = "42501";

async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe("migration 14 — least-privilege runtime role", () => {
  const harness = new PgHarness();
  let owner: pg.Pool;
  let runtime: pg.Pool;
  let role: string;

  beforeAll(async () => {
    await harness.connect();
    ({ owner, runtime, role } = await harness.freshDbWithRuntimeRole("mig14"));
    // A row for the refusals to aim at, written the way the app writes one.
    await createPgAuditLogger(runtime, () => 1_700_000_000_000).record({
      action: "admin.user_blocked",
      actorId: "admin-1",
      subjectType: "user",
      subjectId: "victim",
    });
    await runtime.query(
      `INSERT INTO abuse_signals (kind, subject_id, weight, metadata, at)
       VALUES ('chat.flood', 'victim', 1, '{}'::jsonb, 1)`,
    );
  });
  afterAll(async () => {
    await harness.dropAll();
  });

  it("the runtime role can still read and append to the audit log", async () => {
    const rows = await readAuditLog(runtime, { subjectId: "victim" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("admin.user_blocked");
  });

  describe.each(["audit_log", "abuse_signals"])("%s, as the runtime role", (table) => {
    it("holds no UPDATE, DELETE or TRUNCATE privilege on it", async () => {
      const { rows } = await runtime.query<Record<string, boolean>>(
        `SELECT has_table_privilege($1, 'UPDATE') AS update,
                has_table_privilege($1, 'DELETE') AS delete,
                has_table_privilege($1, 'TRUNCATE') AS truncate,
                has_table_privilege($1, 'INSERT') AS insert,
                has_table_privilege($1, 'SELECT') AS select`,
        [table],
      );
      expect(rows[0]).toEqual({
        update: false,
        delete: false,
        truncate: false,
        insert: true,
        select: true,
      });
    });

    /** TRUNCATE is the one that mattered most: rules do not fire on it, so for the owner it
     *  emptied the table outright. */
    it("is refused TRUNCATE, and UPDATE/DELETE change nothing", async () => {
      expect(await sqlState(runtime.query(`TRUNCATE ${table}`))).toBe(DENIED);
      // UPDATE and DELETE do not reach the privilege check: the DO INSTEAD NOTHING rule
      // rewrites them away first. Either way, nothing may change — and with the rules gone
      // (which this role cannot do, below) the missing privilege would refuse them.
      const before = await owner.query(`SELECT * FROM ${table} ORDER BY id`);
      await runtime.query(`UPDATE ${table} SET at = 0`).catch(() => undefined);
      await runtime.query(`DELETE FROM ${table}`).catch(() => undefined);
      const after = await owner.query(`SELECT * FROM ${table} ORDER BY id`);
      expect(after.rows).toEqual(before.rows);
      expect(after.rows.length).toBeGreaterThan(0);
    });

    it("is refused UPDATE and DELETE by privilege when the rules are absent", async () => {
      // Remove the rules as the owner inside a transaction that is rolled back, to show the
      // second lock holds on its own. The runtime role's statements run on the SAME connection
      // via SET ROLE, so they see the rule-less table.
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DROP RULE ${table}_no_update ON ${table}`);
        await client.query(`DROP RULE ${table}_no_delete ON ${table}`);
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("SAVEPOINT s");
        expect(await sqlState(client.query(`UPDATE ${table} SET at = 0`))).toBe(DENIED);
        await client.query("ROLLBACK TO SAVEPOINT s");
        expect(await sqlState(client.query(`DELETE FROM ${table}`))).toBe(DENIED);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("cannot drop, disable or replace the append-only rules", async () => {
      const update = `${table}_no_update`;
      expect(await sqlState(runtime.query(`DROP RULE ${update} ON ${table}`))).toBe(DENIED);
      expect(await sqlState(runtime.query(`ALTER TABLE ${table} DISABLE RULE ${update}`))).toBe(
        DENIED,
      );
      expect(
        await sqlState(
          runtime.query(
            `CREATE OR REPLACE RULE ${update} AS ON UPDATE TO ${table} DO ALSO NOTHING`,
          ),
        ),
      ).toBe(DENIED);
      expect(await sqlState(runtime.query(`DROP TABLE ${table}`))).toBe(DENIED);
      const { rows } = await owner.query<{ rulename: string; ev_enabled: string }>(
        `SELECT r.rulename, r.ev_enabled FROM pg_rewrite r
           JOIN pg_class c ON c.oid = r.ev_class WHERE c.relname = $1 ORDER BY 1`,
        [table],
      );
      // 'O' = enabled in origin mode, the default.
      expect(rows).toEqual([
        { rulename: `${table}_no_delete`, ev_enabled: "O" },
        { rulename: `${table}_no_update`, ev_enabled: "O" },
      ]);
    });
  });

  it("cannot rewind audit_log's sequence, which would let new rows sort before old ones", async () => {
    expect(
      await sqlState(runtime.query(`SELECT setval(pg_get_serial_sequence('audit_log','id'), 1)`)),
    ).toBe(DENIED);
  });

  it("cannot write the migration ledger or create tables", async () => {
    expect(
      await sqlState(
        runtime.query(`INSERT INTO schema_migrations (id, name, applied_at) VALUES (999,'x',0)`),
      ),
    ).toBe(DENIED);
    expect(await sqlState(runtime.query(`CREATE TABLE sneaky (id int)`))).toBe(DENIED);
  });

  it("still reads and writes ordinary tables", async () => {
    await runtime.query(
      `INSERT INTO phone_blocks (phone_hmac, reason, blocked_at) VALUES ('h1','test',1)`,
    );
    await runtime.query(`UPDATE phone_blocks SET reason = 'changed' WHERE phone_hmac = 'h1'`);
    await runtime.query(`DELETE FROM phone_blocks WHERE phone_hmac = 'h1'`);
  });

  it("gives the runtime role ordinary grants on a table a later migration creates", async () => {
    await owner.query(`CREATE TABLE later_table (id int)`);
    await runtime.query(`INSERT INTO later_table VALUES (1)`);
    await runtime.query(`UPDATE later_table SET id = 2`);
  });

  // ── the boot-time check ────────────────────────────────────────────────────

  it("passes the runtime role and fails the owner", async () => {
    expect(await inspectRuntimeRole(runtime)).toEqual([]);
    // The owner here is the harness's superuser; either finding alone must refuse a boot.
    const problems = await inspectRuntimeRole(owner);
    expect(problems.join("\n")).toMatch(/superuser/);
    expect(problems.join("\n")).toMatch(/owns audit_log/);
    expect(problems.join("\n")).toMatch(/can UPDATE\/DELETE\/TRUNCATE audit_log/);
  });

  it("notices a privilege granted by hand, and the next boot's sync takes it away", async () => {
    await owner.query(`GRANT UPDATE, TRUNCATE ON audit_log TO ${role}`);
    expect(await inspectRuntimeRole(runtime)).toEqual([
      `role ${role} can UPDATE/TRUNCATE audit_log`,
    ]);
    await syncRuntimeGrants(owner, silentLog);
    expect(await inspectRuntimeRole(runtime)).toEqual([]);
  });

  // ── skipped gracefully ─────────────────────────────────────────────────────

  it("migrates cleanly when the configured role does not exist", async () => {
    const { rows } = await owner.query<{ db: string }>("SELECT current_database() AS db");
    const scratch = `${rows[0]!.db}_norole`;
    const admin = new pg.Pool({ connectionString: ADMIN_URL });
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
    await admin.query(`CREATE DATABASE ${scratch}`);
    const u = new URL(ADMIN_URL);
    u.pathname = `/${scratch}`;
    const p = new pg.Pool({
      connectionString: u.toString(),
      options: `-c ${RUNTIME_ROLE_SETTING}=needy_role_that_does_not_exist`,
    });
    const warnings: string[] = [];
    try {
      await migrate(p, silentLog);
      await syncRuntimeGrants(p, { info: () => {}, warn: (m) => warnings.push(m) });
      expect(warnings).toEqual(["runtime database role not found; no grants applied"]);
    } finally {
      await p.end();
      await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
      await admin.end();
    }
  });
});

describe("resolveRuntimeRole", () => {
  it("takes the user from DATABASE_URL", () => {
    expect(resolveRuntimeRole("postgres://needy_app:pw@db:5432/needy", "")).toBe("needy_app");
  });
  it("prefers an explicit name", () => {
    expect(resolveRuntimeRole("postgres://db/needy", "needy_app")).toBe("needy_app");
  });
  /** The name travels in connection startup options, where a space starts a second option. */
  it("refuses a name that could smuggle a second setting", () => {
    expect(() => resolveRuntimeRole("", "app -c role=postgres")).toThrow();
    expect(() => resolveRuntimeRole("postgres://db/needy", "")).toThrow();
    expect(() => resolveRuntimeRole("not a url", "")).toThrow();
  });
});
