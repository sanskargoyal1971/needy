import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeSosAlert } from "@needy/shared";
import { createPgAbuseRepo } from "../domain/abuseStore.js";
import { createPgSosRepo } from "../domain/sosStore.js";
import { PgHarness } from "../test/pgHarness.js";

/** ── Migration 5 ───────────────────────────────────────────────────────────
 *  Real Postgres throughout. Everything asserted below depends on behaviour pg-mem does not
 *  implement: partial indexes, CHECK constraints, `DO INSTEAD NOTHING` rules, `jsonb_object_agg`
 *  and guarded `UPDATE ... RETURNING`.
 */
describe("migration 5 — SOS operator lifecycle + abuse signals", () => {
  const harness = new PgHarness();
  let pool: pg.Pool;

  const REQUESTER = "m5-requester";
  const HELPER = "m5-helper";
  const OPERATOR = "m5-operator";
  const TASK = "m5-task";

  beforeAll(async () => {
    await harness.connect();
    pool = await harness.freshDb("mig5");

    for (const [id, phone] of [
      [REQUESTER, "+919000007001"],
      [HELPER, "+919000007002"],
      [OPERATOR, "+919000007003"],
    ]) {
      await pool.query(
        `INSERT INTO users (id, phone, display_name, role, kyc_status, created_at, updated_at, onboarding_status)
         VALUES ($1,$2,'X','both','verified',1,1,'approved') ON CONFLICT DO NOTHING`,
        [id, phone],
      );
    }
    await pool.query(
      `INSERT INTO tasks (id, requester_id, helper_id, category, state, origin_lat, origin_lng,
                          title, description, price, created_at, updated_at)
       VALUES ($1,$2,$3,'errand','in-progress',12.9,77.6,'Medicine','t',100,1,1)`,
      [TASK, REQUESTER, HELPER],
    );
  });

  afterAll(async () => {
    await harness.dropAll();
  });

  // ── the columns that make an operator's ownership a fact ────────────────────

  describe("sos_alerts lifecycle", () => {
    const repo = () => createPgSosRepo(pool);

    async function raise(id: string, raisedBy = REQUESTER, at = 1_000): Promise<void> {
      await repo().create(
        makeSosAlert({
          id,
          taskId: TASK,
          raisedBy,
          kind: "panic",
          at: { lat: 12.9, lng: 77.6 },
          createdAt: at,
          updatedAt: at,
        }),
      );
    }

    it("round-trips an alert through raise → acknowledge → resolve", async () => {
      await raise("a-lifecycle");

      const acked = await repo().acknowledge("a-lifecycle", OPERATOR, 2_000);
      expect(acked).not.toBeNull();
      expect(acked!.status).toBe("acknowledged");
      expect(acked!.acknowledgedBy).toBe(OPERATOR);
      expect(acked!.acknowledgedAt).toBe(2_000);

      const resolved = await repo().resolve("a-lifecycle", OPERATOR, "called her, all fine", 3_000);
      expect(resolved!.status).toBe("resolved");
      expect(resolved!.resolvedBy).toBe(OPERATOR);
      expect(resolved!.resolutionNote).toBe("called her, all fine");
      // The acknowledgement survives the resolution — how long the alarm waited for a human
      // is recoverable afterwards, which is the number this platform should be judged on.
      expect(resolved!.acknowledgedAt).toBe(2_000);
    });

    /** The guard IS the concurrency control. Two operators clicking at the same moment both
     *  run the same statement and exactly one matches a row. */
    it("lets exactly one operator acknowledge", async () => {
      await raise("a-race");
      const [first, second] = await Promise.all([
        repo().acknowledge("a-race", "op-1", 2_000),
        repo().acknowledge("a-race", "op-2", 2_001),
      ]);
      const winners = [first, second].filter((r) => r != null);
      expect(winners).toHaveLength(1);
      const stored = await repo().get("a-race");
      expect(stored!.acknowledgedBy).toBe(winners[0]!.acknowledgedBy);
    });

    /** Acknowledging an alert the raiser already stood down would assert an emergency they
     *  have said is over. */
    it("refuses to acknowledge a cancelled alert", async () => {
      await raise("a-cancelled");
      await repo().setStatus("a-cancelled", "cancelled", 2_000);
      expect(await repo().acknowledge("a-cancelled", OPERATOR, 3_000)).toBeNull();
    });

    /** Resolving twice must not silently overwrite the first operator's account of it. */
    it("refuses a second resolution", async () => {
      await raise("a-twice");
      await repo().resolve("a-twice", "op-1", "first note", 2_000);
      expect(await repo().resolve("a-twice", "op-2", "second note", 3_000)).toBeNull();
      expect((await repo().get("a-twice"))!.resolutionNote).toBe("first note");
    });

    /** Oldest first — an operator surface sorted newest-first buries the person who has been
     *  waiting longest under every fresh arrival. */
    it("queues open alerts oldest first and drops closed ones", async () => {
      await raise("q-old", REQUESTER, 100);
      await raise("q-new", HELPER, 900);
      await raise("q-done", REQUESTER, 500);
      await repo().resolve("q-done", OPERATOR, "handled", 1_500);

      const open = await repo().listOpen(50);
      const ids = open.map((a) => a.id);
      expect(ids).toContain("q-old");
      expect(ids).toContain("q-new");
      expect(ids).not.toContain("q-done");
      expect(ids.indexOf("q-old")).toBeLessThan(ids.indexOf("q-new"));
    });

    it("counts a user's recent alerts for the repeat signal", async () => {
      await raise("c-1", "counter-user", 10_000);
      await raise("c-2", "counter-user", 20_000);
      await raise("c-3", "counter-user", 30_000);
      expect(await repo().countRaisedBySince("counter-user", 15_000)).toBe(2);
      expect(await repo().countRaisedBySince("counter-user", 0)).toBe(3);
    });

    /** The database had no opinion at all about these two columns before this migration. */
    it("rejects a status or kind outside the union", async () => {
      await expect(
        pool.query(
          `INSERT INTO sos_alerts (id, task_id, raised_by, kind, status, created_at, updated_at)
           VALUES ('bad-status',$1,$2,'panic','handled-i-guess',1,1)`,
          [TASK, REQUESTER],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          `INSERT INTO sos_alerts (id, task_id, raised_by, kind, status, created_at, updated_at)
           VALUES ('bad-kind',$1,$2,'vibes','raised',1,1)`,
          [TASK, REQUESTER],
        ),
      ).rejects.toThrow();
    });
  });

  // ── abuse signals ───────────────────────────────────────────────────────────

  describe("abuse_signals", () => {
    const repo = () => createPgAbuseRepo(pool);

    beforeAll(async () => {
      const rows: [string, string, number, number][] = [
        // [kind, subject, weight, at]
        ["handoff.code_burned", "noisy-helper", 5, 1_000],
        ["handoff.code_burned", "noisy-helper", 5, 2_000],
        ["chat.flood", "noisy-helper", 2, 3_000],
        ["chat.flood", "chatty-user", 2, 4_000],
        // Deliberately outside every window the tests below use.
        ["sos.repeated", "ancient-user", 1, 10],
      ];
      for (const [kind, subject, weight, at] of rows) {
        await repo().record({
          kind: kind as never,
          subjectId: subject,
          taskId: TASK,
          weight,
          metadata: { seeded: true },
          at,
        });
      }
    });

    it("rolls signals up per subject, highest score first", async () => {
      const tallies = await repo().tally({ since: 500, limit: 50 });
      const noisy = tallies.find((t) => t.subjectId === "noisy-helper");
      const chatty = tallies.find((t) => t.subjectId === "chatty-user");

      expect(noisy).toBeDefined();
      expect(noisy!.score).toBe(12); // 5 + 5 + 2
      expect(noisy!.total).toBe(3);
      expect(noisy!.byKind["handoff.code_burned"]).toBe(2);
      expect(noisy!.byKind["chat.flood"]).toBe(1);
      expect(noisy!.firstAt).toBe(1_000);
      expect(noisy!.lastAt).toBe(3_000);

      // Sorted by score, so the heavier subject leads.
      expect(tallies.indexOf(noisy!)).toBeLessThan(tallies.indexOf(chatty!));
    });

    it("honours the window", async () => {
      const tallies = await repo().tally({ since: 2_500, limit: 50 });
      expect(tallies.map((t) => t.subjectId)).not.toContain("ancient-user");
      expect(tallies.find((t) => t.subjectId === "noisy-helper")!.total).toBe(1);
    });

    it("lists one subject's individual observations, newest first", async () => {
      const signals = await repo().listForSubject("noisy-helper", 0, 100);
      expect(signals).toHaveLength(3);
      expect(signals[0]!.at).toBe(3_000);
      expect(signals[0]!.metadata).toEqual({ seeded: true });
    });

    /** Evidence the application can rewrite is not evidence. Both of these are rules that
     *  rewrite the statement into nothing rather than raising, so the assertion is that the
     *  row is UNCHANGED and still there — not that the statement threw. */
    it("is append-only: updates and deletes do nothing", async () => {
      const before = await repo().listForSubject("chatty-user", 0, 10);
      expect(before).toHaveLength(1);

      await pool.query(`UPDATE abuse_signals SET weight = 999 WHERE subject_id = 'chatty-user'`);
      await pool.query(`DELETE FROM abuse_signals WHERE subject_id = 'chatty-user'`);

      const after = await repo().listForSubject("chatty-user", 0, 10);
      expect(after).toHaveLength(1);
      expect(after[0]!.weight).toBe(2);
    });
  });
});
