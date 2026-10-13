import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPgUserRepo } from "../repos.js";
import { createInMemoryTotpRepo, createPgTotpRepo, type TotpRepository } from "../totpRepo.js";
import { makeUser } from "../types.js";
import { PgHarness } from "../../test/pgHarness.js";

/** The authenticator-credential repository, against real Postgres with migration 9 applied.
 *
 *  The properties that matter here are the ATOMIC ones — a step claimed once, a recovery code
 *  spent once, an activation that happens once — and those live in the SQL. An in-memory twin
 *  that gets them right says nothing about whether the conditional UPDATE does, so the same
 *  cases run against both.
 */
describe.each(["postgres", "in-memory"] as const)("totp repository (%s)", (kind) => {
  const harness = new PgHarness();
  let pool: pg.Pool | null = null;
  let repo: TotpRepository;
  let n = 0;
  let userId = "";

  beforeAll(async () => {
    if (kind !== "postgres") return;
    await harness.connect();
    pool = await harness.freshDb("totp_repo");
  });

  afterAll(async () => {
    if (kind === "postgres") await harness.dropAll();
  });

  beforeEach(async () => {
    n += 1;
    userId = `totp-u${n}`;
    if (pool) {
      // The credential row is a foreign key onto a real account.
      await createPgUserRepo(pool).create(makeUser({ id: userId, phone: `+9198000000${10 + n}` }));
      repo = createPgTotpRepo(pool);
    } else {
      repo = createInMemoryTotpRepo();
    }
  });

  const HASHES = ["h1", "h2", "h3"];

  it("holds a secret as pending until it is activated", async () => {
    expect(await repo.get(userId)).toBeNull();
    expect(await repo.savePending(userId, "enc-1", 100)).toBe(true);
    expect(await repo.get(userId)).toMatchObject({
      status: "pending",
      secretEnc: "enc-1",
      lastStep: null,
      createdAt: 100,
      activatedAt: null,
    });

    // Starting again replaces the unfinished attempt.
    expect(await repo.savePending(userId, "enc-2", 150)).toBe(true);
    expect((await repo.get(userId))?.secretEnc).toBe("enc-2");

    expect(await repo.activate(userId, 7, 200, HASHES)).toBe(true);
    expect(await repo.get(userId)).toMatchObject({
      status: "active",
      lastStep: 7,
      activatedAt: 200,
    });
    expect(await repo.recoveryCodesRemaining(userId)).toBe(3);
  });

  /** Enrolment must never be a way to swap a working authenticator for the caller's own. */
  it("refuses to overwrite an active credential with a pending one", async () => {
    await repo.savePending(userId, "enc-1", 100);
    await repo.activate(userId, 7, 200, HASHES);

    expect(await repo.savePending(userId, "enc-attacker", 300)).toBe(false);
    expect(await repo.get(userId)).toMatchObject({ status: "active", secretEnc: "enc-1" });
  });

  it("activates exactly once, even when two confirmations race", async () => {
    await repo.savePending(userId, "enc-1", 100);
    const results = await Promise.all([
      repo.activate(userId, 7, 200, ["a1", "a2"]),
      repo.activate(userId, 7, 200, ["b1", "b2"]),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // One set of codes, not two overlaid.
    expect(await repo.recoveryCodesRemaining(userId)).toBe(2);
    expect(await repo.activate(userId, 8, 300, ["c1"])).toBe(false);
  });

  it("will not accept a step from a credential that is only pending", async () => {
    await repo.savePending(userId, "enc-1", 100);
    expect(await repo.acceptStep(userId, 5)).toBe(false);
    expect(await repo.consumeRecoveryCode(userId, "h1", 100)).toBe(false);
  });

  it("accepts each time-step once and only moves forward", async () => {
    await repo.savePending(userId, "enc-1", 100);
    await repo.activate(userId, 10, 200, HASHES);

    expect(await repo.acceptStep(userId, 10)).toBe(false); // the step that enrolled it
    expect(await repo.acceptStep(userId, 11)).toBe(true);
    expect(await repo.acceptStep(userId, 11)).toBe(false); // replay
    expect(await repo.acceptStep(userId, 9)).toBe(false); // older than the floor
    expect(await repo.acceptStep(userId, 13)).toBe(true);
    expect(await repo.acceptStep(userId, 12)).toBe(false);
    expect((await repo.get(userId))?.lastStep).toBe(13);
  });

  /** The replay check as one conditional write: two requests carrying the same captured
   *  code must not both read the old floor and both pass. */
  it("lets only one of several simultaneous claims on a step succeed", async () => {
    await repo.savePending(userId, "enc-1", 100);
    await repo.activate(userId, 10, 200, HASHES);
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.acceptStep(userId, 20)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("spends a recovery code once, under concurrency too", async () => {
    await repo.savePending(userId, "enc-1", 100);
    await repo.activate(userId, 10, 200, HASHES);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => repo.consumeRecoveryCode(userId, "h2", 300)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repo.consumeRecoveryCode(userId, "h2", 400)).toBe(false);
    expect(await repo.consumeRecoveryCode(userId, "never-issued", 400)).toBe(false);
    expect(await repo.recoveryCodesRemaining(userId)).toBe(2);
  });

  it("removes the credential and its recovery codes together", async () => {
    await repo.savePending(userId, "enc-1", 100);
    await repo.activate(userId, 10, 200, HASHES);
    await repo.remove(userId);

    expect(await repo.get(userId)).toBeNull();
    expect(await repo.recoveryCodesRemaining(userId)).toBe(0);
    expect(await repo.consumeRecoveryCode(userId, "h1", 300)).toBe(false);

    // A fresh enrolment starts clean and does not inherit the old codes.
    await repo.savePending(userId, "enc-2", 400);
    await repo.activate(userId, 30, 500, ["n1"]);
    expect(await repo.consumeRecoveryCode(userId, "h1", 600)).toBe(false);
    expect(await repo.consumeRecoveryCode(userId, "n1", 600)).toBe(true);
  });
});
