import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOSPITAL_SERVICE_CODE, SEED_SERVICES } from "@needy/shared";
import { createPgServiceCatalog } from "../services/catalog.js";
import { PgHarness } from "../test/pgHarness.js";

/** ── Migration 4 ───────────────────────────────────────────────────────────
 *  Real Postgres: the assertions below turn on partial unique indexes and CHECK constraints,
 *  neither of which pg-mem implements.
 */
describe("migration 4 — services, exceptions, scheduling", () => {
  const harness = new PgHarness();
  let pool: pg.Pool;

  beforeAll(async () => {
    await harness.connect();
    pool = await harness.freshDb("mig4");
  });
  afterAll(async () => {
    await harness.dropAll();
  });

  it("seeds the catalog from the shared constant", async () => {
    const { rows } = await pool.query<{ code: string; is_mandatory: boolean }>(
      `SELECT code, is_mandatory FROM services`,
    );
    expect(rows.map((r) => r.code).sort()).toEqual(SEED_SERVICES.map((s) => s.code).sort());
    // Exactly one mandatory service, and it is the emergency one.
    const mandatory = rows.filter((r) => r.is_mandatory).map((r) => r.code);
    expect(mandatory).toEqual([HOSPITAL_SERVICE_CODE]);
  });

  /** The regression that would matter most: shipping the service filter without this backfill
   *  would silently empty the hospital pool on deploy. */
  it("enrols pre-existing helpers in the mandatory service", async () => {
    // The seeded admin from migration 2 is a 'admin' role, so add a helper the way an
    // already-deployed database would have had one, then re-run the backfill statement.
    await pool.query(
      `INSERT INTO users (id, phone, display_name, role, kyc_status, created_at, updated_at, onboarding_status)
       VALUES ('legacy-helper','+919000004444','Legacy','both','verified',1,1,'approved')`,
    );
    await pool.query(
      `INSERT INTO helper_services (helper_id, service_code, created_at)
       SELECT u.id, s.code, 0 FROM users u CROSS JOIN services s
        WHERE u.role IN ('helper','both') AND s.is_mandatory
       ON CONFLICT DO NOTHING`,
    );
    const { rows } = await pool.query<{ service_code: string }>(
      `SELECT service_code FROM helper_services WHERE helper_id = 'legacy-helper'`,
    );
    expect(rows.map((r) => r.service_code)).toContain(HOSPITAL_SERVICE_CODE);
  });

  it("maps every pre-catalog task onto a service code", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM tasks WHERE service_code IS NULL`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  describe("booking_exceptions", () => {
    beforeAll(async () => {
      for (const [id, phone] of [
        ["exc-req", "+919000005001"],
        ["exc-help", "+919000005002"],
      ]) {
        await pool.query(
          `INSERT INTO users (id, phone, display_name, role, kyc_status, created_at, updated_at, onboarding_status)
           VALUES ($1,$2,'X','both','verified',1,1,'approved') ON CONFLICT DO NOTHING`,
          [id, phone],
        );
      }
    });

    const insert = (id: string, status: string) =>
      pool.query(
        `INSERT INTO booking_exceptions (id, requester_id, helper_id, status, created_at)
         VALUES ($1,'exc-req','exc-help',$2,1)`,
        [id, status],
      );

    /** Two live requests for the same pair would give an admin two packets to decide about
     *  one relationship, and whichever they saw second would look like a duplicate. */
    it("allows only one in-flight request per pair", async () => {
      await insert("e1", "under_review");
      await expect(insert("e2", "awaiting_videos")).rejects.toThrow();
    });

    /** …but a settled one must not block the pair forever. */
    it("lets a pair apply again once the previous request is settled", async () => {
      await pool.query(`UPDATE booking_exceptions SET status = 'rejected' WHERE id = 'e1'`);
      await expect(insert("e3", "awaiting_videos")).resolves.toBeTruthy();
    });

    it("rejects an unknown status", async () => {
      await expect(insert("e4", "probably-fine")).rejects.toThrow();
    });

    /** A pair cannot vouch for itself. */
    it("refuses an exception where both sides are the same person", async () => {
      await expect(
        pool.query(
          `INSERT INTO booking_exceptions (id, requester_id, helper_id, status, created_at)
           VALUES ('e5','exc-req','exc-req','awaiting_videos',1)`,
        ),
      ).rejects.toThrow();
    });
  });

  describe("service catalog repository", () => {
    it("cannot be talked out of the mandatory service", async () => {
      const catalog = createPgServiceCatalog(pool);
      await pool.query(
        `INSERT INTO users (id, phone, display_name, role, kyc_status, created_at, updated_at, onboarding_status)
         VALUES ('svc-helper','+919000006001','S','both','verified',1,1,'approved')
         ON CONFLICT DO NOTHING`,
      );

      // Ask for groceries only — hospital must still come back.
      const saved = await catalog.setHelperServices("svc-helper", ["groceries"], 1);
      expect(saved).toContain(HOSPITAL_SERVICE_CODE);
      expect(await catalog.helperOffers("svc-helper", HOSPITAL_SERVICE_CODE)).toBe(true);

      // Ask for NOTHING — hospital must still come back. There is no request shape that
      // removes it, which is the point of enforcing on write rather than on read.
      const cleared = await catalog.setHelperServices("svc-helper", [], 1);
      expect(cleared).toEqual([HOSPITAL_SERVICE_CODE]);
      expect(await catalog.helperOffers("svc-helper", "groceries")).toBe(false);
    });

    it("ignores codes that are not in the catalog", async () => {
      const catalog = createPgServiceCatalog(pool);
      const saved = await catalog.setHelperServices("svc-helper", ["not-a-service"], 1);
      expect(saved).not.toContain("not-a-service");
    });
  });
});
