import { beforeAll, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import type { DbPool } from "../../db.js";
import { runMigrations } from "../../db.js";
import { createPgSessionRepo, createPgUserRepo } from "../repos.js";
import type { SessionRepository, UserRepository } from "../repos.js";

/** Runs the real users/sessions SQL against pg-mem so the Postgres identity repos have an
 *  exercised read path (no write-only tables), matching the in-memory coverage in auth.test. */
describe("postgres auth repositories", () => {
  let users: UserRepository;
  let sessions: SessionRepository;

  beforeAll(async () => {
    const mem = newDb();
    const pool = new (mem.adapters.createPg().Pool)() as unknown as DbPool;
    await runMigrations(pool);
    users = createPgUserRepo(pool);
    sessions = createPgSessionRepo(pool);
  });

  it("creates, reads (by id + phone) and updates a user", async () => {
    await users.create({
      id: "u1",
      phone: "+919876543210",
      email: null,
      displayName: "User 3210",
      role: "requester",
      kycStatus: "unverified",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
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
