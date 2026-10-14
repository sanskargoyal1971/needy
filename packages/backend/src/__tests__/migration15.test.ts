import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditRowHash, GENESIS_HASH, verifyAuditChain } from "../audit/chain.js";
import { createPgAuditLogger } from "../audit/log.js";
import { MIGRATIONS, migrate } from "../migrations.js";
import { PgHarness, silentLog } from "../test/pgHarness.js";

/** ── Migration 15: the chain guard and the recorded chain start ────────────
 *  Before this, the runtime role's INSERT on audit_log covered every column, and nothing in
 *  the database looked at them: each refusal below succeeded, and each of those rows either
 *  stopped the verifier for good or was never walked at all.
 *
 *  Against real Postgres: a trigger, privileges and session settings are the whole subject.
 */

/** check_violation, raised by the trigger. */
const REFUSED = "23514";
/** insufficient_privilege, or "must be owner". */
const DENIED = "42501";

async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe("migration 15 — audit chain guard", () => {
  const harness = new PgHarness();
  let owner: pg.Pool;
  let runtime: pg.Pool;

  beforeAll(async () => {
    await harness.connect();
    ({ owner, runtime } = await harness.freshDbWithRuntimeRole("mig15"));
    const audit = createPgAuditLogger(runtime, () => 1_700_000_000_000);
    await audit.record({ action: "admin.user_blocked", actorId: "admin-1" });
    await audit.record({ action: "admin.user_unblocked", actorId: "admin-1" });
  });
  afterAll(async () => {
    await harness.dropAll();
  });

  /**
   * One INSERT on a single connection, as the runtime role, inside a transaction holding the
   * chain lock as the app's writer does. `id` is what to insert; `draw` says whether to call
   * nextval first (the guard insists on the id this session drew). Hashes default to a
   * well-formed, correctly chained pair, so each test changes only the thing it is about.
   */
  async function insertAsRuntime(opts: {
    id?: (drawn: string) => string;
    draw?: boolean;
    prevHash?: string | null;
    rowHash?: string | null;
  }): Promise<string | undefined> {
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      const head = await client.query<{ row_hash: string }>(
        `SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1`,
      );
      const prev = head.rows[0]?.row_hash ?? GENESIS_HASH;
      let drawn = "0";
      if (opts.draw !== false) {
        const { rows } = await client.query<{ id: string }>(
          `SELECT nextval('audit_log_id_seq')::text AS id`,
        );
        drawn = rows[0]!.id;
      }
      const id = opts.id ? opts.id(drawn) : drawn;
      const rowHash = auditRowHash(prev, {
        id,
        at: "1",
        action: "admin.role_changed",
        actorId: "ghost",
        actorRole: null,
        subjectType: null,
        subjectId: null,
        ip: null,
        metadata: {},
      });
      return await sqlState(
        client.query(
          `INSERT INTO audit_log (id, action, actor_id, at, metadata, prev_hash, row_hash)
           VALUES ($1::bigint, 'admin.role_changed', 'ghost', 1, '{}'::jsonb, $2, $3)`,
          [
            id,
            opts.prevHash === undefined ? prev : opts.prevHash,
            opts.rowHash === undefined ? rowHash : opts.rowHash,
          ],
        ),
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  it("accepts a row chained the way the app chains one", async () => {
    expect(await insertAsRuntime({})).toBeUndefined();
  });

  it("refuses a row with no hashes, or malformed ones", async () => {
    expect(await insertAsRuntime({ rowHash: null })).toBe(REFUSED);
    expect(await insertAsRuntime({ prevHash: null })).toBe(REFUSED);
    expect(await insertAsRuntime({ rowHash: "not-a-hash" })).toBe(REFUSED);
    // The plain INSERT the review used: no id, no hashes at all.
    expect(
      await sqlState(
        runtime.query(
          `INSERT INTO audit_log (action, actor_id, at) VALUES ('admin.role_changed','ghost',1)`,
        ),
      ),
    ).toBe(REFUSED);
  });

  /** A huge id became the head every later honest row chained onto, out of id order. */
  it("refuses an id the session did not draw: huge, zero, negative, or with none drawn", async () => {
    expect(await insertAsRuntime({ id: () => "9000000000000000000" })).toBe(REFUSED);
    expect(await insertAsRuntime({ id: () => "0" })).toBe(REFUSED);
    expect(await insertAsRuntime({ id: () => "-1" })).toBe(REFUSED);
    expect(await insertAsRuntime({ id: (d) => String(BigInt(d) + 1n) })).toBe(REFUSED);
    expect(await insertAsRuntime({ draw: false, id: () => "999" })).toBe(REFUSED);
  });

  it("refuses a row that does not chain onto the current head", async () => {
    expect(await insertAsRuntime({ prevHash: GENESIS_HASH })).toBe(REFUSED);
    expect(await insertAsRuntime({ prevHash: "a".repeat(64) })).toBe(REFUSED);
  });

  /** Drawn early, outside the lock, and inserted after a later id committed: it would sort
   *  before a row it claims to follow. */
  it("refuses an id that does not sort after every existing row", async () => {
    const client = await runtime.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `SELECT nextval('audit_log_id_seq')::text AS id`,
      );
      await createPgAuditLogger(runtime, () => 1).record({ action: "sos.raised", actorId: null });
      await client.query("BEGIN");
      const head = await client.query<{ row_hash: string }>(
        `SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`,
      );
      expect(
        await sqlState(
          client.query(
            `INSERT INTO audit_log (id, action, actor_id, at, prev_hash, row_hash)
             VALUES ($1::bigint, 'admin.role_changed', 'ghost', 1, $2, $3)`,
            [rows[0]!.id, head.rows[0]!.row_hash, "b".repeat(64)],
          ),
        ),
      ).toBe(REFUSED);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("cannot be disabled, dropped or replaced by the runtime role", async () => {
    expect(
      await sqlState(runtime.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_chain_guard`)),
    ).toBe(DENIED);
    expect(await sqlState(runtime.query(`DROP TRIGGER audit_log_chain_guard ON audit_log`))).toBe(
      DENIED,
    );
    expect(
      await sqlState(
        runtime.query(
          `CREATE OR REPLACE FUNCTION audit_log_chain_guard() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
        ),
      ),
    ).toBe(DENIED);
    // "replica" mode skips ordinary triggers; setting it is a superuser's privilege.
    expect(await sqlState(runtime.query(`SET session_replication_role = replica`))).toBe(DENIED);
    const { rows } = await owner.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger WHERE tgname = 'audit_log_chain_guard'`,
    );
    expect(rows).toEqual([{ tgenabled: "O" }]);
  });

  it("lets the runtime role read where the chain starts, never move it", async () => {
    const { rows } = await runtime.query(
      `SELECT legacy_max_id, legacy_rows FROM audit_chain_start`,
    );
    expect(rows).toHaveLength(1);
    expect(await sqlState(runtime.query(`UPDATE audit_chain_start SET legacy_max_id = 1e9`))).toBe(
      DENIED,
    );
    expect(await sqlState(runtime.query(`DELETE FROM audit_chain_start`))).toBe(DENIED);
    expect(
      await sqlState(
        runtime.query(
          `INSERT INTO audit_chain_start (singleton, legacy_max_id, legacy_rows, recorded_at)
           VALUES (false, 1, 1, 1)`,
        ),
      ),
    ).toBe(DENIED);
  });

  it("leaves a chain the app wrote verifying", async () => {
    expect(await verifyAuditChain(runtime)).toMatchObject({ ok: true, brokenCount: 0 });
  });
});

describe("migration 15 — recording where the chain starts", () => {
  const harness = new PgHarness();
  const before15 = MIGRATIONS.filter((m) => m.id < 15);

  beforeAll(async () => {
    await harness.connect();
  });
  afterAll(async () => {
    await harness.dropAll();
  });

  async function start(pool: pg.Pool) {
    const { rows } = await pool.query<{ legacy_max_id: string; legacy_rows: string }>(
      `SELECT legacy_max_id::text, legacy_rows::text FROM audit_chain_start`,
    );
    return rows;
  }

  it("records nothing as legacy on a fresh database", async () => {
    const pool = await harness.freshDb("mig15_fresh");
    expect(await start(pool)).toEqual([{ legacy_max_id: "0", legacy_rows: "0" }]);
  });

  it("ends the legacy prefix just before the first hashed row", async () => {
    const { owner, runtime } = await harness.freshDbWithRuntimeRole("mig15_mixed", before15);
    await owner.query(
      `INSERT INTO audit_log (action, actor_id, at) VALUES ('sos.raised','u1',1), ('sos.resolved','a1',2)`,
    );
    // Written between migrations 14 and 15, so already hashed.
    const audit = createPgAuditLogger(runtime, () => 3);
    await audit.record({ action: "admin.user_blocked", actorId: "a1" });
    await audit.record({ action: "admin.user_unblocked", actorId: "a1" });
    await migrate(owner, silentLog);
    expect(await start(owner)).toEqual([{ legacy_max_id: "2", legacy_rows: "2" }]);
    expect(await verifyAuditChain(runtime)).toMatchObject({
      ok: true,
      checked: 2,
      legacyUnchained: 2,
      legacyRecorded: 2,
    });
  });

  it("treats every row as legacy when none was hashed yet", async () => {
    const pool = await harness.freshDb("mig15_old", before15);
    await pool.query(
      `INSERT INTO audit_log (action, actor_id, at) VALUES ('sos.raised','u1',1), ('sos.resolved','a1',2), ('sos.raised','u2',3)`,
    );
    await migrate(pool, silentLog);
    expect(await start(pool)).toEqual([{ legacy_max_id: "3", legacy_rows: "3" }]);
  });
});
