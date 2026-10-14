import express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVerificationRouter, type VerificationRouterDeps } from "../../admin/verification.js";
import { signAccessToken } from "../../auth/jwt.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { makeUser } from "../../auth/types.js";
import { MIGRATIONS, migrate } from "../../migrations.js";
import { PgHarness, silentLog } from "../../test/pgHarness.js";
import {
  auditRowHash,
  canonicalJson,
  GENESIS_HASH,
  verifyAuditChain,
  type ChainedRow,
} from "../chain.js";
import { createPgAuditLogger, type AuditEntry } from "../log.js";

/** ── The audit hash chain ──────────────────────────────────────────────────
 *  Written as the runtime role, tampered with as the owner — the one role that still can —
 *  and verified as the runtime role again, which is how the admin endpoint runs it.
 */

const NOW = 1_700_000_000_000;

function entry(i: number, metadata: Record<string, unknown> = {}): AuditEntry {
  return {
    action: "admin.document_viewed",
    actorId: `admin-${i % 3}`,
    actorRole: "admin",
    subjectType: "user",
    subjectId: `subject-${i}`,
    metadata: { i, ...metadata },
    ip: i % 2 ? "203.0.113.7" : null,
  };
}

/** The owner disabling the rules and the insert guard for a moment is exactly the tampering
 *  the chain is for: the role separation stops the app doing this, and nothing in Postgres
 *  stops a superuser. */
async function asOwnerBypassingRules(owner: pg.Pool, sql: string, params: unknown[] = []) {
  await owner.query(`ALTER TABLE audit_log DISABLE RULE audit_log_no_update`);
  await owner.query(`ALTER TABLE audit_log DISABLE RULE audit_log_no_delete`);
  await owner.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_chain_guard`);
  try {
    await owner.query(sql, params);
  } finally {
    await owner.query(`ALTER TABLE audit_log ENABLE RULE audit_log_no_update`);
    await owner.query(`ALTER TABLE audit_log ENABLE RULE audit_log_no_delete`);
    await owner.query(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_chain_guard`);
  }
}

async function ids(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id::text FROM audit_log ORDER BY id`);
  return rows.map((r) => r.id);
}

describe("canonicalJson", () => {
  it("does not depend on key order, at any depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });
  /** JavaScript orders integer-like keys first whatever order they were added in, so a sort
   *  followed by JSON.stringify would not actually sort them. */
  it("sorts integer-like keys as strings too", () => {
    expect(canonicalJson({ b: 1, "10": 2, "2": 3 })).toBe('{"10":2,"2":3,"b":1}');
  });
  it("drops undefined members as JSON does", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("audit hash chain", () => {
  const harness = new PgHarness();

  beforeAll(async () => {
    await harness.connect();
  });
  afterAll(async () => {
    await harness.dropAll();
  });

  it("verifies a chain written by the app, including metadata JSONB reorders", async () => {
    const { runtime } = await harness.freshDbWithRuntimeRole("chain_ok");
    const audit = createPgAuditLogger(runtime, () => NOW);
    // Keys JSONB will hand back in a different order, nesting, non-ASCII text, a float, a
    // Date (JSON turns it into a string) and an undefined member (JSON drops it).
    await audit.record(entry(1, { zeta: 1, alpha: { b: 2, a: [3, { z: 0, y: 1 }] } }));
    await audit.record(entry(2, { note: "नमस्ते — ok", ratio: 0.1 + 0.2, big: 2 ** 53 }));
    await audit.record(entry(3, { when: new Date(NOW), gone: undefined }));
    await audit.record({ action: "sos.raised", actorId: null });

    const report = await verifyAuditChain(runtime);
    expect(report).toMatchObject({
      ok: true,
      checked: 4,
      legacyUnchained: 0,
      legacyRecorded: 0,
      firstBroken: null,
      lastBroken: null,
      brokenCount: 0,
    });
    const { rows } = await runtime.query<{ id: string; row_hash: string; prev_hash: string }>(
      `SELECT id::text, row_hash, prev_hash FROM audit_log ORDER BY id`,
    );
    expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(report.headId).toBe(rows[3]!.id);
    expect(report.headHash).toBe(rows[3]!.row_hash);
  });

  it("walks across batch boundaries", async () => {
    const { runtime } = await harness.freshDbWithRuntimeRole("chain_batches");
    const audit = createPgAuditLogger(runtime, () => NOW);
    for (let i = 0; i < 7; i++) await audit.record(entry(i));
    expect(await verifyAuditChain(runtime, { batchSize: 2 })).toMatchObject({
      ok: true,
      checked: 7,
    });
  });

  describe("tampering by the owner", () => {
    let owner: pg.Pool;
    let runtime: pg.Pool;

    beforeAll(async () => {
      ({ owner, runtime } = await harness.freshDbWithRuntimeRole("chain_tamper"));
    });

    async function writeFive() {
      const audit = createPgAuditLogger(runtime, () => NOW);
      for (let i = 0; i < 5; i++) await audit.record(entry(i));
    }

    it("names the edited row, at its position, and still verifies the rows after it", async () => {
      await writeFive();
      const all = await ids(runtime);
      await asOwnerBypassingRules(
        owner,
        `UPDATE audit_log SET metadata = '{"i": 99}'::jsonb WHERE id = $1`,
        [all[2]],
      );
      const broken = { id: all[2], position: 3, reason: "row_hash_mismatch" };
      expect(await verifyAuditChain(runtime)).toMatchObject({
        ok: false,
        checked: 4,
        firstBroken: broken,
        lastBroken: broken,
        brokenCount: 1,
      });
    });

    it("an edit whose hash was recomputed still breaks the next link", async () => {
      const all = await ids(runtime);
      // Recompute row 3's own hash honestly, as a careful tamperer would.
      const { rows } = await owner.query<{
        prev_hash: string;
        at: string;
        action: string;
        actor_id: string | null;
        actor_role: string | null;
        subject_type: string | null;
        subject_id: string | null;
        ip: string | null;
        metadata: unknown;
      }>(
        `SELECT prev_hash, at::text, action, actor_id, actor_role, subject_type, subject_id, ip,
                metadata
           FROM audit_log WHERE id = $1`,
        [all[2]],
      );
      const r = rows[0]!;
      const row: ChainedRow = {
        id: all[2]!,
        at: r.at,
        action: r.action,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        ip: r.ip,
        metadata: r.metadata,
      };
      await asOwnerBypassingRules(owner, `UPDATE audit_log SET row_hash = $1 WHERE id = $2`, [
        auditRowHash(r.prev_hash, row),
        all[2],
      ]);
      expect(await verifyAuditChain(runtime)).toMatchObject({
        ok: false,
        checked: 4,
        firstBroken: { id: all[3], position: 4, reason: "prev_hash_mismatch" },
        brokenCount: 1,
      });
    });
  });

  it("names the row after a deleted one", async () => {
    const { owner, runtime } = await harness.freshDbWithRuntimeRole("chain_delete");
    const audit = createPgAuditLogger(runtime, () => NOW);
    for (let i = 0; i < 5; i++) await audit.record(entry(i));
    const all = await ids(runtime);
    await asOwnerBypassingRules(owner, `DELETE FROM audit_log WHERE id = $1`, [all[1]]);
    expect(await verifyAuditChain(runtime)).toMatchObject({
      ok: false,
      checked: 3,
      // The row that WAS third is now second in the table.
      firstBroken: { id: all[2], position: 2, reason: "prev_hash_mismatch" },
      brokenCount: 1,
    });
  });

  it("names a row slipped in without a hash", async () => {
    const { owner, runtime } = await harness.freshDbWithRuntimeRole("chain_insert");
    const audit = createPgAuditLogger(runtime, () => NOW);
    await audit.record(entry(1));
    await audit.record(entry(2));
    const ghost = await owner.query<{ id: string }>(
      `SELECT nextval('audit_log_id_seq')::text AS id`,
    );
    await asOwnerBypassingRules(
      owner,
      `INSERT INTO audit_log (id, action, actor_id, at) VALUES ($1, 'admin.role_changed', 'ghost', 1)`,
      [ghost.rows[0]!.id],
    );
    await audit.record(entry(3));
    expect(await verifyAuditChain(runtime)).toMatchObject({
      ok: false,
      checked: 3,
      firstBroken: { id: ghost.rows[0]!.id, position: 3, reason: "unchained_row" },
      brokenCount: 1,
    });
  });

  /** Migration 14 worked out where the unhashed prefix ends from the rows themselves, so
   *  nulling every hash made the whole log "legacy" and it verified with nothing checked. */
  it("fails when the owner strips every hash", async () => {
    const { owner, runtime } = await harness.freshDbWithRuntimeRole("chain_strip");
    const audit = createPgAuditLogger(runtime, () => NOW);
    for (let i = 0; i < 3; i++) await audit.record(entry(i));
    const all = await ids(runtime);
    await asOwnerBypassingRules(owner, `UPDATE audit_log SET prev_hash = NULL, row_hash = NULL`);
    expect(await verifyAuditChain(runtime)).toMatchObject({
      ok: false,
      checked: 0,
      legacyUnchained: 0,
      firstBroken: { id: all[0], position: 1, reason: "unchained_row" },
      lastBroken: { id: all[2], position: 3, reason: "unchained_row" },
      brokenCount: 3,
    });
  });

  /** The walk used to start above id 0, so a row there was never looked at. */
  it("fails when a row is slipped in below the chain, at id 0", async () => {
    const { owner, runtime } = await harness.freshDbWithRuntimeRole("chain_zero");
    const audit = createPgAuditLogger(runtime, () => NOW);
    await audit.record(entry(1));
    await asOwnerBypassingRules(
      owner,
      `INSERT INTO audit_log (id, action, actor_id, at) VALUES (0, 'admin.role_changed', 'ghost', 1)`,
    );
    expect(await verifyAuditChain(runtime)).toMatchObject({
      ok: false,
      checked: 1,
      legacyUnchained: 1,
      legacyRecorded: 0,
      brokenCount: 0,
    });
  });

  /** The trigger cannot recompute a row's hash, so the runtime role CAN still insert a row
   *  whose hash is garbage. It used to stop the verifier there for good; now it marks one row
   *  and a later edit by the owner is still found. */
  it("a planted row does not hide tampering after it", async () => {
    const { owner, runtime } = await harness.freshDbWithRuntimeRole("chain_planted");
    const audit = createPgAuditLogger(runtime, () => NOW);
    await audit.record(entry(1));
    const client = await runtime.connect();
    let planted: string;
    try {
      await client.query("BEGIN");
      const head = await client.query<{ row_hash: string }>(
        `SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`,
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO audit_log (id, action, actor_id, at, prev_hash, row_hash)
         VALUES (nextval('audit_log_id_seq'), 'admin.role_changed', 'ghost', 1, $1, $2)
         RETURNING id::text`,
        [head.rows[0]!.row_hash, "f".repeat(64)],
      );
      planted = rows[0]!.id;
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    for (let i = 2; i < 5; i++) await audit.record(entry(i));
    const all = await ids(runtime);
    await asOwnerBypassingRules(owner, `UPDATE audit_log SET actor_id = 'nobody' WHERE id = $1`, [
      all[3],
    ]);
    expect(await verifyAuditChain(runtime)).toMatchObject({
      ok: false,
      checked: 3,
      firstBroken: { id: planted, position: 2, reason: "row_hash_mismatch" },
      lastBroken: { id: all[3], position: 4, reason: "row_hash_mismatch" },
      brokenCount: 2,
    });
  });

  it("counts rows from before the chain existed and verifies from there", async () => {
    const before15 = MIGRATIONS.filter((m) => m.id < 15);
    const { owner, runtime } = await harness.freshDbWithRuntimeRole("chain_legacy", before15);
    // What a database that ran migrations 1–13 holds: rows with no hash at all.
    await owner.query(
      `INSERT INTO audit_log (action, actor_id, at) VALUES ('sos.raised','u1',1), ('sos.resolved','a1',2)`,
    );
    await migrate(owner, silentLog);
    const audit = createPgAuditLogger(runtime, () => NOW);
    await audit.record(entry(1));
    await audit.record(entry(2));
    expect(await verifyAuditChain(runtime)).toMatchObject({
      ok: true,
      checked: 2,
      legacyUnchained: 2,
      legacyRecorded: 2,
    });

    // One more unhashed row in the prefix: unverifiable on its own, but the count shows it.
    await asOwnerBypassingRules(
      owner,
      `INSERT INTO audit_log (id, action, actor_id, at) VALUES (-5, 'sos.resolved', 'a2', 3)`,
    );
    expect(await verifyAuditChain(runtime)).toMatchObject({
      ok: false,
      legacyUnchained: 3,
      legacyRecorded: 2,
      brokenCount: 0,
    });
  });

  /** Without the lock, two inserts read the same head and both chain onto it: the log forks,
   *  and the second of them fails verification although nobody tampered with anything. */
  it("concurrent inserts still form one valid chain", async () => {
    const { runtime } = await harness.freshDbWithRuntimeRole("chain_concurrent");
    const audit = createPgAuditLogger(runtime, () => NOW);
    await Promise.all(Array.from({ length: 40 }, (_, i) => audit.record(entry(i))));
    const report = await verifyAuditChain(runtime);
    expect(report).toMatchObject({ ok: true, checked: 40 });
    const { rows } = await runtime.query<{ n: string; parents: string }>(
      `SELECT count(*)::text AS n, count(DISTINCT prev_hash)::text AS parents FROM audit_log`,
    );
    expect(rows[0]).toEqual({ n: "40", parents: "40" });
  });

  describe("GET /admin/audit/verify", () => {
    let app: express.Express;
    let owner: pg.Pool;
    let runtime: pg.Pool;

    beforeAll(async () => {
      ({ owner, runtime } = await harness.freshDbWithRuntimeRole("chain_route"));
      const audit = createPgAuditLogger(runtime, () => NOW);
      for (let i = 0; i < 3; i++) await audit.record(entry(i));
      const users = createInMemoryUserRepo();
      await users.create(makeUser({ id: "ops", phone: "+919000007001", role: "admin" }));
      await users.create(makeUser({ id: "someone", phone: "+919000007002", role: "requester" }));
      app = express();
      app.use(express.json());
      // Only what the route reaches; the rest of the surface has its own tests.
      app.use(
        createVerificationRouter({
          users,
          pool: runtime,
          now: () => NOW,
        } as unknown as VerificationRouterDeps),
      );
    });

    const as = (sub: string, role: "admin" | "requester") =>
      `Bearer ${signAccessToken({ sub, role, displayName: sub })}`;

    it("is staff only", async () => {
      expect((await request(app).get("/admin/audit/verify")).status).toBe(401);
      const res = await request(app)
        .get("/admin/audit/verify")
        .set("authorization", as("someone", "requester"));
      expect(res.status).toBe(403);
      // A participant who forged an admin claim is still refused: the role comes from the row.
      const forged = await request(app)
        .get("/admin/audit/verify")
        .set("authorization", as("someone", "admin"));
      expect(forged.status).toBe(403);
    });

    it("reports a clean chain, then the first broken link", async () => {
      const ok = await request(app)
        .get("/admin/audit/verify")
        .set("authorization", as("ops", "admin"));
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ durable: true, ok: true, checked: 3, firstBroken: null });

      const all = await ids(owner);
      await asOwnerBypassingRules(owner, `UPDATE audit_log SET actor_id = 'nobody' WHERE id = $1`, [
        all[1],
      ]);
      const broken = await request(app)
        .get("/admin/audit/verify")
        .set("authorization", as("ops", "admin"));
      expect(broken.status).toBe(200);
      expect(broken.body).toMatchObject({
        durable: true,
        ok: false,
        firstBroken: { id: all[1], position: 2, reason: "row_hash_mismatch" },
      });
    });
  });
});
