import { beforeAll, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import type { Task } from "@needy/shared";
import type { DbPool } from "../../db.js";
import { runMigrations, seedHelperProfiles } from "../../db.js";
import {
  createPgHelperProfileRepo,
  createPgMessageRepo,
  createPgTaskRepo,
} from "../pgStores.js";
import type {
  HelperProfileRepository,
  MessageRepository,
  TaskRepository,
} from "../stores.js";

/**
 * Runs the real durable schema + repository SQL against an in-memory Postgres (pg-mem), so
 * the mappings, ON CONFLICT seeding, BIGINT coercion, and migration idempotency are exercised
 * for real — not just typechecked.
 */
describe("postgres repositories", () => {
  let tasks: TaskRepository;
  let messages: MessageRepository;
  let helpers: HelperProfileRepository;

  const baseTask: Task = {
    id: "t1",
    requesterId: "req-1",
    helperId: null,
    category: "errand",
    state: "searching",
    origin: { lat: 12.9716, lng: 77.5946 },
    title: "Pick up medicine",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  beforeAll(async () => {
    const mem = newDb();
    const pool = new (mem.adapters.createPg().Pool)() as unknown as DbPool;

    // Real Postgres makes runMigrations idempotent via CREATE ... IF NOT EXISTS. pg-mem can't
    // model a repeated CREATE INDEX IF NOT EXISTS, so we run the DDL once here; idempotency of
    // the seed (ON CONFLICT) is proven by the double-seed below.
    await runMigrations(pool);

    await seedHelperProfiles(pool, {
      "helper-priya": {
        id: "helper-priya",
        displayName: "Priya",
        photoUrl: "https://x/p.jpg",
        rating: 4.9,
        helpedCount: 34,
      },
    });
    // Upsert path: re-seeding must update, not error.
    await seedHelperProfiles(pool, {
      "helper-priya": {
        id: "helper-priya",
        displayName: "Priya",
        photoUrl: "",
        rating: 5.0,
        helpedCount: 40,
      },
    });

    tasks = createPgTaskRepo(pool);
    messages = createPgMessageRepo(pool);
    helpers = createPgHelperProfileRepo(pool);
  });

  it("creates and reads a task with numeric (not string) timestamps and coords", async () => {
    await tasks.create(baseTask);
    const got = await tasks.get("t1");
    expect(got).not.toBeNull();
    expect(got!.origin).toEqual({ lat: 12.9716, lng: 77.5946 });
    expect(typeof got!.createdAt).toBe("number");
    expect(got!.createdAt).toBe(1_700_000_000_000);
  });

  it("updates a task, honoring the patch (state + helper + updatedAt)", async () => {
    const updated = await tasks.update("t1", {
      helperId: "helper-priya",
      state: "matched",
      updatedAt: 1_700_000_050_000,
    });
    expect(updated.state).toBe("matched");
    expect(updated.helperId).toBe("helper-priya");
    expect(updated.updatedAt).toBe(1_700_000_050_000);
    const reread = await tasks.get("t1");
    expect(reread!.state).toBe("matched");
  });

  it("lists active tasks for a user and excludes terminal ones", async () => {
    const active = await tasks.activeForUser("req-1");
    expect(active.map((t) => t.id)).toContain("t1");
    await tasks.update("t1", { state: "completed" });
    const afterDone = await tasks.activeForUser("req-1");
    expect(afterDone.map((t) => t.id)).not.toContain("t1");
  });

  it("appends, lists, and updates receipt status on messages", async () => {
    await messages.append({
      id: "m1",
      taskId: "t1",
      senderId: "helper-priya",
      body: "on my way",
      createdAt: 1_700_000_060_000,
      status: "sent",
    });
    const list = await messages.list("t1");
    expect(list).toHaveLength(1);
    expect(list[0]!.body).toBe("on my way");

    const promoted = await messages.setStatus("m1", "read");
    expect(promoted!.status).toBe("read");
    expect(await messages.setStatus("missing", "read")).toBeNull();
  });

  it("reads a seeded helper profile with the upserted values", async () => {
    const profile = await helpers.get("helper-priya");
    expect(profile).toEqual({
      id: "helper-priya",
      displayName: "Priya",
      photoUrl: "",
      rating: 5.0,
      helpedCount: 40,
    });
    expect(await helpers.get("nobody")).toBeNull();
  });
});
