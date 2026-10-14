import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../migrations.js";
import { PgHarness, silentLog } from "../test/pgHarness.js";

/** ── Migration 10 ──────────────────────────────────────────────────────────
 *  Real Postgres. The database is built up to migration 9 — the schema a deploy of the
 *  authenticator change found — with sessions already in it, and only then is 10 applied:
 *  the rows it acts on have to exist before it runs, or the test proves nothing.
 */
describe("migration 10 — staff sessions from before the second factor end", () => {
  const harness = new PgHarness();
  let pool: pg.Pool;

  const LIVE = [
    ["s-root", "m10-root"],
    ["s-admin", "m10-admin"],
    ["s-asha", "m10-asha"],
  ] as const;

  beforeAll(async () => {
    await harness.connect();
    pool = await harness.freshDb(
      "mig10",
      MIGRATIONS.filter((m) => m.id < 10),
    );

    for (const [id, phone, role, username] of [
      ["m10-root", "+990000010001", "super_admin", "m10-root"],
      ["m10-admin", "+919000010002", "admin", null],
      ["m10-asha", "+919000010003", "requester", null],
    ]) {
      await pool.query(
        `INSERT INTO users (id, phone, display_name, role, kyc_status, created_at, updated_at,
                            onboarding_status, username)
         VALUES ($1,$2,'X',$3,'verified',1,1,'approved',$4)`,
        [id, phone, role, username],
      );
    }
    // A long way from expiry, which is the point: refresh rotation would have kept these
    // alive indefinitely.
    const farFuture = Date.now() + 365 * 86_400_000;
    for (const [id, userId] of LIVE) {
      await pool.query(
        `INSERT INTO sessions (id, user_id, refresh_token_hash, created_at, expires_at)
         VALUES ($1,$2,$3,1,$4)`,
        [id, userId, `hash-${id}`, farFuture],
      );
    }
    // Already revoked long ago — its timestamp is evidence and must not be rewritten.
    await pool.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, created_at, expires_at, revoked_at)
       VALUES ('s-root-old','m10-root','hash-old',1,$1,42)`,
      [farFuture],
    );

    expect(await migrate(pool, silentLog)).toEqual([10]);
  });

  afterAll(async () => {
    await harness.dropAll();
  });

  const revokedAt = async (id: string) => {
    const { rows } = await pool.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM sessions WHERE id = $1`,
      [id],
    );
    return rows[0].revoked_at == null ? null : Number(rows[0].revoked_at);
  };

  /** The gap: a super admin session minted on a password alone, before the authenticator. */
  it("revokes a super admin's live session", async () => {
    expect(await revokedAt("s-root")).toBeGreaterThan(1_600_000_000_000);
  });

  it("revokes an ordinary admin's live session", async () => {
    expect(await revokedAt("s-admin")).toBeGreaterThan(1_600_000_000_000);
  });

  it("leaves participants signed in", async () => {
    expect(await revokedAt("s-asha")).toBeNull();
  });

  it("does not rewrite when an already-revoked session ended", async () => {
    expect(await revokedAt("s-root-old")).toBe(42);
  });
});
