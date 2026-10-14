import { describe, expect, it } from "vitest";
import type { DbPool } from "../../db.js";
import { createPgAuditLogger } from "../log.js";

/** ── The audit writer's failure path ───────────────────────────────────────
 *  A fake pool, because the cases are a connection that breaks mid-transaction and one whose
 *  ROLLBACK fails, which a healthy local Postgres will not produce on demand.
 */

function fakePool(opts: { rollbackFails: boolean }) {
  const released: unknown[] = [];
  const client = {
    async query(sql: string) {
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "ROLLBACK") {
        if (opts.rollbackFails) throw new Error("Connection terminated unexpectedly");
        return { rows: [] };
      }
      throw new Error("Connection terminated unexpectedly");
    },
    release(err?: unknown) {
      released.push(err);
    },
  };
  const pool = { connect: async () => client } as unknown as DbPool;
  return { pool, released };
}

describe("createPgAuditLogger, when the write fails", () => {
  /** Released normally, a broken connection went back into the runtime pool and failed the
   *  next unrelated request that drew it. */
  it("destroys the connection when ROLLBACK also failed", async () => {
    const { pool, released } = fakePool({ rollbackFails: true });
    await createPgAuditLogger(pool, () => 1).record({ action: "sos.raised", actorId: null });
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it("returns the connection to the pool when ROLLBACK succeeded", async () => {
    const { pool, released } = fakePool({ rollbackFails: false });
    await createPgAuditLogger(pool, () => 1).record({ action: "sos.raised", actorId: null });
    expect(released).toEqual([undefined]);
  });
});
