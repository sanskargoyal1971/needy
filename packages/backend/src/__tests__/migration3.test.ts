import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgAuditLogger, readAuditLog } from "../audit/log.js";
import { PgHarness } from "../test/pgHarness.js";

/** ── Migration 3 ───────────────────────────────────────────────────────────
 *  Against real Postgres, because the three things worth asserting here — a partial index, a
 *  `DO INSTEAD NOTHING` rule, and a CHECK constraint — are all features pg-mem does not
 *  implement. A fake would report success for a schema that does not exist.
 */
describe("migration 3 — identity, documents, audit", () => {
  const harness = new PgHarness();
  let pool: pg.Pool;

  beforeAll(async () => {
    await harness.connect();
    pool = await harness.freshDb("mig3");
  });
  afterAll(async () => {
    await harness.dropAll();
  });

  it("adds the identity columns to users", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
    );
    const cols = new Set(rows.map((r) => r.column_name));
    for (const c of [
      "date_of_birth",
      "gender",
      "onboarding_status",
      "area_label",
      "rejection_reason",
      "blocked_at",
      "reviewed_by",
      "submitted_at",
    ]) {
      expect(cols, `missing column ${c}`).toContain(c);
    }
  });

  it("creates phone_blocks, kyc_documents and audit_log", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(rows.map((r) => r.table_name));
    expect(tables).toContain("phone_blocks");
    expect(tables).toContain("kyc_documents");
    expect(tables).toContain("audit_log");
  });

  it("constrains onboarding_status to the known set", async () => {
    await pool.query(
      `INSERT INTO users (id, phone, display_name, role, kyc_status, created_at, updated_at, onboarding_status)
       VALUES ('m3-ok','+919000000101','Ok','requester','unverified',1,1,'under_review')`,
    );
    await expect(
      pool.query(
        `INSERT INTO users (id, phone, display_name, role, kyc_status, created_at, updated_at, onboarding_status)
         VALUES ('m3-bad','+919000000102','Bad','requester','unverified',1,1,'definitely-approved')`,
      ),
    ).rejects.toThrow();
  });

  it("allows only one current document per kind per user", async () => {
    const insert = (id: string, key: string) =>
      pool.query(
        `INSERT INTO kyc_documents (id, user_id, kind, storage_key, content_type, size_bytes, sha256, created_at)
         VALUES ($1,'m3-ok','gov_id',$2,'image/jpeg',10,'abc',1)`,
        [id, key],
      );
    await insert("d1", "kyc/m3-ok/gov_id-1.jpg");
    // The UPSERT in the repo depends on this uniqueness; without it a reviewer would face a
    // pile of versions with no defined "current" one.
    await expect(insert("d2", "kyc/m3-ok/gov_id-2.jpg")).rejects.toThrow();
  });

  /** The guarantee the whole audit design rests on. A log the application can rewrite is not
   *  evidence: the first thing a compromised admin session does is delete its own trail. */
  describe("audit_log is append-only at the database level", () => {
    it("silently discards UPDATE and DELETE", async () => {
      const audit = createPgAuditLogger(pool, () => 1_700_000_000_000);
      await audit.record({
        action: "onboarding.approved",
        actorId: "admin-1",
        actorRole: "admin",
        subjectType: "user",
        subjectId: "m3-ok",
        metadata: { note: "looks fine" },
      });

      const before = await readAuditLog(pool, { subjectId: "m3-ok" });
      expect(before).toHaveLength(1);

      // Both of these "succeed" — the rule rewrites them into nothing, which is what makes
      // the table tamper-resistant rather than merely conventionally append-only.
      await pool.query(`UPDATE audit_log SET action = 'onboarding.rejected'`);
      await pool.query(`DELETE FROM audit_log`);

      const after = await readAuditLog(pool, { subjectId: "m3-ok" });
      expect(after).toHaveLength(1);
      expect(after[0]!.action).toBe("onboarding.approved");
    });

    it("still accepts new rows", async () => {
      const audit = createPgAuditLogger(pool, () => 1_700_000_001_000);
      await audit.record({
        action: "admin.document_viewed",
        actorId: "admin-2",
        subjectType: "user",
        subjectId: "m3-ok",
      });
      const rows = await readAuditLog(pool, { subjectId: "m3-ok" });
      expect(rows.map((r) => r.action)).toContain("admin.document_viewed");
      // Newest first.
      expect(rows[0]!.action).toBe("admin.document_viewed");
    });
  });

  it("grades pre-existing accounts instead of locking them all out", async () => {
    // The backfill in migration 3 runs against rows that existed before the column did. The
    // seeded admin from migration 2 is exactly such a row, and it must come out approved —
    // otherwise shipping the gate locks the operator out of their own review queue.
    const { rows } = await pool.query<{ onboarding_status: string }>(
      `SELECT onboarding_status FROM users WHERE id = 'admin-seed'`,
    );
    expect(rows[0]?.onboarding_status).toBe("approved");
  });
});
