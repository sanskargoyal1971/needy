import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../../migrations.js";
import { PgHarness, silentLog } from "../../test/pgHarness.js";
import { createPgAdminUserQueries } from "../../admin/verificationRepo.js";
import { createPiiCipher, phoneIndex, pii } from "../../crypto/pii.js";
import { createPgPhoneBlockRepo, legacyPhoneHmac } from "../phoneBlocks.js";
import { createPgUserRepo } from "../repos.js";
import { makeUser } from "../types.js";
import { backfillUserPii } from "../userPii.js";

/** ── Phone number and date of birth, sealed at rest (migration 12) ─────────
 *  Real Postgres, and every assertion that matters reads the ROW, not the repository: a
 *  repository that encrypts on the way in and decrypts on the way out looks identical from
 *  above whether or not anything was ever encrypted. What a dump would show is the question.
 */

/** Every column of the row as one string — what `pg_dump` or a stray `SELECT *` would see. */
async function rawRow(pool: pg.Pool, id: string): Promise<string> {
  const { rows } = await pool.query<{ j: string }>(
    `SELECT row_to_json(u)::text AS j FROM users u WHERE id = $1`,
    [id],
  );
  expect(rows).toHaveLength(1);
  return rows[0].j;
}

async function columns(pool: pg.Pool, id: string) {
  const { rows } = await pool.query<{
    phone: string | null;
    phone_enc: string | null;
    phone_hash: string | null;
    phone_last4: string | null;
    date_of_birth: unknown;
    date_of_birth_enc: string | null;
  }>(
    `SELECT phone, phone_enc, phone_hash, phone_last4, date_of_birth, date_of_birth_enc
       FROM users WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe("users: personal data sealed by the repository", () => {
  const harness = new PgHarness();
  let pool: pg.Pool;

  beforeAll(async () => {
    await harness.connect();
    pool = await harness.freshDb("pii_repo");
  });
  afterAll(async () => {
    await harness.dropAll();
  });

  it("never writes the number or the date of birth in the clear", async () => {
    const users = createPgUserRepo(pool);
    await users.create(
      makeUser({ id: "p1", phone: "+919876543210", dateOfBirth: "1948-02-29", createdAt: 1 }),
    );

    const raw = await rawRow(pool, "p1");
    expect(raw).not.toContain("9876543210");
    expect(raw).not.toContain("1948-02-29");
    const c = await columns(pool, "p1");
    expect(c.phone).toBeNull();
    expect(c.date_of_birth).toBeNull();
    expect(c.phone_hash).toBe(phoneIndex("+919876543210"));
    expect(c.phone_last4).toBe("3210");
    expect(pii.keyIdOf(c.phone_enc!)).toBe(pii.currentKeyId);

    // …and the rest of the app still sees both, unchanged.
    const back = await users.getById("p1");
    expect(back?.phone).toBe("+919876543210");
    expect(back?.dateOfBirth).toBe("1948-02-29");
  });

  it("finds an account by its number through the blind index", async () => {
    const users = createPgUserRepo(pool);
    expect((await users.getByPhone("+919876543210"))?.id).toBe("p1");
    expect((await users.getByPhone(" +919876543210 "))?.id).toBe("p1");
    expect(await users.getByPhone("+919876543211")).toBeNull();
  });

  it("keeps the number sealed through an update, including a changed number", async () => {
    const users = createPgUserRepo(pool);
    await users.update("p1", { phone: "+919811112222", dateOfBirth: "1950-01-01" });
    const raw = await rawRow(pool, "p1");
    expect(raw).not.toContain("9811112222");
    expect(raw).not.toContain("9876543210");
    expect(raw).not.toContain("1950-01-01");
    expect((await users.getByPhone("+919811112222"))?.id).toBe("p1");
    expect(await users.getByPhone("+919876543210")).toBeNull();
    expect((await users.getById("p1"))?.dateOfBirth).toBe("1950-01-01");
  });

  /** Uniqueness moved from the plaintext column to the index; it must not have been lost. */
  it("still refuses a second account with the same number", async () => {
    const users = createPgUserRepo(pool);
    await expect(
      users.create(makeUser({ id: "p2", phone: "+919811112222", createdAt: 2 })),
    ).rejects.toMatchObject({ code: "23505" });
    // Nor can SQL leave a sealed number without its index, which no lookup could find.
    await expect(
      pool.query(
        `INSERT INTO users (id, phone_enc, display_name, created_at, updated_at)
         VALUES ('p3', 'v1.x.y.z.w', 'X', 1, 1)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // Nor an account with no number in either form.
    await expect(
      pool.query(
        `INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('p4','X',1,1)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses to hand back a row whose ciphertext was moved from another account", async () => {
    const users = createPgUserRepo(pool);
    await users.create(makeUser({ id: "p5", phone: "+919800000005", createdAt: 5 }));
    // An attacker with write access copies their own sealed number onto p1's row.
    await pool.query(
      `UPDATE users SET phone_enc = (SELECT phone_enc FROM users WHERE id = 'p5') WHERE id = 'p1'`,
    );
    await expect(users.getById("p1")).rejects.toThrow(/could not be decrypted/);
    // Put it back so the rest of the file has a working p1.
    await pool.query(`UPDATE users SET phone_enc = $2 WHERE id = $1`, [
      "p1",
      pii.encrypt("+919811112222", "users.phone:p1"),
    ]);
    expect((await users.getById("p1"))?.phone).toBe("+919811112222");
  });

  it("rotates keys: the old key still opens, the next write re-seals under the new one", async () => {
    const OLD = "rotation-old-".padEnd(40, "o");
    const NEW = "rotation-new-".padEnd(40, "n");
    const before = createPiiCipher({
      currentKey: OLD,
      previousKeys: [],
      indexKey: "ix".repeat(20),
    });
    const during = createPiiCipher({
      currentKey: NEW,
      previousKeys: [OLD],
      indexKey: "ix".repeat(20),
    });
    const after = createPiiCipher({ currentKey: NEW, previousKeys: [], indexKey: "ix".repeat(20) });

    await createPgUserRepo(pool, before).create(
      makeUser({ id: "r1", phone: "+919700000001", dateOfBirth: "1990-05-05", createdAt: 1 }),
    );
    expect(before.keyIdOf((await columns(pool, "r1")).phone_enc!)).toBe(before.currentKeyId);

    const rotated = createPgUserRepo(pool, during);
    expect((await rotated.getByPhone("+919700000001"))?.dateOfBirth).toBe("1990-05-05");
    await rotated.update("r1", { displayName: "Rotated" });
    const c = await columns(pool, "r1");
    expect(during.keyIdOf(c.phone_enc!)).toBe(after.currentKeyId);
    expect(during.keyIdOf(c.date_of_birth_enc!)).toBe(after.currentKeyId);

    // With the old key gone entirely, the re-sealed row still opens.
    const u = await createPgUserRepo(pool, after).getById("r1");
    expect(u?.phone).toBe("+919700000001");
    expect(u?.dateOfBirth).toBe("1990-05-05");
  });

  it("stores a phone block under the blind index, not the number", async () => {
    const blocks = createPgPhoneBlockRepo(pool);
    await blocks.block("+919600000001", "test", null, 1);
    const { rows } = await pool.query<{ phone_hmac: string }>(
      `SELECT phone_hmac FROM phone_blocks`,
    );
    expect(rows.map((r) => r.phone_hmac)).toEqual([phoneIndex("+919600000001")]);
    expect(await blocks.isBlocked("+919600000001")).toBe(true);
    await blocks.unblock("+919600000001");
    expect(await blocks.isBlocked("+919600000001")).toBe(false);
  });

  it("searches the admin directory by whole number or last four, never by fragment", async () => {
    const queries = createPgAdminUserQueries(pool);
    const ids = async (search: string) =>
      (await queries.listUsers({ search, limit: 50 })).map((u) => u.id).sort();
    expect(await ids("+919811112222")).toEqual(["p1"]);
    expect(await ids("2222")).toEqual(["p1"]);
    expect(await ids("98111")).toEqual([]);
    const [entry] = await queries.listUsers({ search: "2222", limit: 1 });
    expect(entry.phoneMasked).toBe("***2222");
  });
});

describe("users: boot-time backfill of rows written before migration 12", () => {
  const harness = new PgHarness();
  let pool: pg.Pool;
  const LEGACY = [
    ["b1", "+919100000001", "1940-01-31"],
    ["b2", "+919100000002", null],
    ["b3", "+919100000003", "2001-12-01"],
    ["b4", "+919100000004", "1975-07-15"],
    ["b5", "+919100000005", null],
  ] as const;

  beforeAll(async () => {
    await harness.connect();
    pool = await harness.freshDb(
      "pii_backfill",
      MIGRATIONS.filter((m) => m.id < 12),
    );
    for (const [id, phone, dob] of LEGACY) {
      await pool.query(
        `INSERT INTO users (id, phone, display_name, created_at, updated_at, date_of_birth)
         VALUES ($1,$2,'Legacy',1,1,$3)`,
        [id, phone, dob],
      );
    }
    // A block written the old way, under the HMAC keyed off the JWT secret.
    await pool.query(
      `INSERT INTO phone_blocks (phone_hmac, reason, blocked_at) VALUES ($1, 'old', 1)`,
      [legacyPhoneHmac("+919100000004")],
    );
    // And one whose number has no account, so the backfill has no plaintext to re-key it from.
    await pool.query(
      `INSERT INTO phone_blocks (phone_hmac, reason, blocked_at) VALUES ($1, 'orphan', 1)`,
      [legacyPhoneHmac("+919100009999")],
    );
    // Only up to 12: later migrations are not what this test is about.
    expect(
      await migrate(
        pool,
        silentLog,
        MIGRATIONS.filter((m) => m.id <= 12),
      ),
    ).toEqual([12]);
  });
  afterAll(async () => {
    await harness.dropAll();
  });

  it("leaves pre-backfill rows readable, through the plaintext fallback", async () => {
    // Between `migrate` and the backfill — or for a row an older build writes — nothing breaks.
    expect((await createPgUserRepo(pool).getByPhone("+919100000001"))?.id).toBe("b1");
  });

  /** Two instances booting together: one backfills, the other waits on the lock and then has
   *  nothing to do. Neither throws, and no row is sealed twice. Small batches, so the run
   *  genuinely crosses several transactions. */
  it("seals every row once, even with two instances racing", async () => {
    const [a, b] = await Promise.all([
      backfillUserPii(pool, silentLog, { batchSize: 2 }),
      backfillUserPii(pool, silentLog, { batchSize: 2 }),
    ]);
    // Five legacy rows plus the admin migration 2 seeds.
    expect(a.sealed + b.sealed).toBe(LEGACY.length + 1);
    expect(a.conflicts + b.conflicts).toBe(0);
    expect([a.sealed, b.sealed]).toContain(0);
  });

  it("leaves no number or date of birth in the clear in any column", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM users WHERE phone IS NOT NULL OR date_of_birth IS NOT NULL`,
    );
    expect(Number(rows[0].n)).toBe(0);
    for (const [id, phone, dob] of LEGACY) {
      const raw = await rawRow(pool, id);
      expect(raw).not.toContain(phone.slice(1));
      if (dob) expect(raw).not.toContain(dob);
    }
    expect(await rawRow(pool, "admin-seed")).not.toContain("9999999999");
  });

  it("reads every backfilled row back exactly, and finds it by number", async () => {
    const users = createPgUserRepo(pool);
    for (const [id, phone, dob] of LEGACY) {
      const u = await users.getByPhone(phone);
      expect(u?.id).toBe(id);
      expect(u?.phone).toBe(phone);
      expect(u?.dateOfBirth).toBe(dob);
    }
    expect((await users.getByPhone("+919999999999"))?.id).toBe("admin-seed");
  });

  it("is idempotent: a re-run seals nothing and rewrites nothing", async () => {
    const before = await pool.query(
      `SELECT id, phone_enc, date_of_birth_enc FROM users ORDER BY id`,
    );
    expect(await backfillUserPii(pool, silentLog)).toEqual({ sealed: 0, conflicts: 0 });
    const after = await pool.query(
      `SELECT id, phone_enc, date_of_birth_enc FROM users ORDER BY id`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("re-keys an old-style block, and still honours one it could not re-key", async () => {
    const { rows } = await pool.query<{ phone_hmac: string; reason: string }>(
      `SELECT phone_hmac, reason FROM phone_blocks ORDER BY reason`,
    );
    expect(rows).toEqual([
      { phone_hmac: phoneIndex("+919100000004"), reason: "old" },
      { phone_hmac: legacyPhoneHmac("+919100009999"), reason: "orphan" },
    ]);
    const blocks = createPgPhoneBlockRepo(pool);
    expect(await blocks.isBlocked("+919100000004")).toBe(true);
    expect(await blocks.isBlocked("+919100009999")).toBe(true);
    expect(await blocks.isBlocked("+919100000001")).toBe(false);
  });

  /** A plaintext row whose number another account already holds sealed — what an older build
   *  writing during a deploy could leave. Sealing it would break uniqueness; guessing which
   *  account is real is not the backfill's call. It stays put, is counted, and blocks nothing. */
  it("skips a row that would duplicate another account's number, and seals the rest", async () => {
    await pool.query(
      `INSERT INTO users (id, phone, display_name, created_at, updated_at, date_of_birth)
       VALUES ('dup', '+919100000001', 'Dup', 1, 1, '1960-03-03'),
              ('late', '+919100000077', 'Late', 1, 1, NULL)`,
    );
    const res = await backfillUserPii(pool, silentLog);
    expect(res).toEqual({ sealed: 1, conflicts: 1 });
    const dup = await columns(pool, "dup");
    expect(dup.phone).toBe("+919100000001");
    expect(dup.phone_enc).toBeNull();
    // Its date of birth cannot conflict with anything, so that much was still sealed.
    expect(dup.date_of_birth).toBeNull();
    expect(dup.date_of_birth_enc).not.toBeNull();
    expect((await columns(pool, "late")).phone).toBeNull();
    // The lookup still lands on the sealed account, not the stray.
    expect((await createPgUserRepo(pool).getByPhone("+919100000001"))?.id).toBe("b1");
  });
});
