import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgSessionRepo, createPgUserRepo } from "../repos.js";
import type { SessionRepository, UserRepository } from "../repos.js";
import { makeUser } from "../types.js";
import { PgHarness } from "../../test/pgHarness.js";

/** Exercises the Postgres identity repos against a real database with every migration
 *  applied, so the tables have a read path and not just a write one.
 *
 *  Previously this ran on pg-mem against `runMigrations` (the migration-1 baseline DDL), which
 *  meant it silently fell behind the moment migration 3 added columns the repo writes: the
 *  repo compiled, the test passed, and the INSERT would have failed in production. Running
 *  the real runner is what keeps this test honest as the schema moves.
 */
describe("postgres auth repositories", () => {
  const harness = new PgHarness();
  let users: UserRepository;
  let sessions: SessionRepository;

  beforeAll(async () => {
    await harness.connect();
    const pool = await harness.freshDb("auth_repos");
    users = createPgUserRepo(pool);
    sessions = createPgSessionRepo(pool);
  });

  afterAll(async () => {
    await harness.dropAll();
  });

  it("creates, reads (by id + phone) and updates a user", async () => {
    await users.create(
      makeUser({
        id: "u1",
        phone: "+919876543210",
        displayName: "User 3210",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      }),
    );
    expect((await users.getById("u1"))?.phone).toBe("+919876543210");
    expect((await users.getByPhone("+919876543210"))?.id).toBe("u1");

    const upgraded = await users.update("u1", { role: "helper", kycStatus: "verified", updatedAt: 1_700_000_050_000 });
    expect(upgraded.role).toBe("helper");
    expect(upgraded.kycStatus).toBe("verified");
    expect((await users.getById("u1"))?.role).toBe("helper");
  });

  it("creates a session, reads it by hash, and revokes it", async () => {
    await sessions.create({
      id: "s1",
      userId: "u1",
      refreshTokenHash: "hash-abc",
      userAgent: "vitest",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000_000 + 86_400_000,
      revokedAt: null,
    });
    expect((await sessions.getByHash("hash-abc"))?.revokedAt).toBeNull();

    await sessions.revoke("s1", 1_700_000_060_000);
    expect((await sessions.getByHash("hash-abc"))?.revokedAt).toBe(1_700_000_060_000);
  });

  it("revokes all sessions for a user", async () => {
    await sessions.create({
      id: "s2",
      userId: "u1",
      refreshTokenHash: "hash-def",
      userAgent: "vitest",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000_000 + 86_400_000,
      revokedAt: null,
    });
    await sessions.revokeAllForUser("u1", 1_700_000_070_000);
    expect((await sessions.getByHash("hash-def"))?.revokedAt).toBe(1_700_000_070_000);
  });
});
