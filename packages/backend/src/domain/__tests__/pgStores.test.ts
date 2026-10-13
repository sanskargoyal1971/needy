import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Task } from "@needy/shared";
import { seedHelperProfiles } from "../../db.js";
import { PgHarness } from "../../test/pgHarness.js";
import { createPgHelperProfileRepo, createPgMessageRepo, createPgTaskRepo } from "../pgStores.js";
import type { HelperProfileRepository, MessageRepository, TaskRepository } from "../stores.js";

/**
 * Runs the real repository SQL against a real Postgres with every migration applied.
 *
 * Previously this used pg-mem against `runMigrations` — the migration-1 baseline DDL — which
 * meant it silently fell behind the moment a later migration added a column the repos write.
 * Migration 4's `service_code` is exactly that case: the repo compiled, the test passed, and
 * the INSERT would have failed in production. Running the real runner is what keeps this
 * honest as the schema moves.
 */
describe("postgres repositories", () => {
  const harness = new PgHarness();
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
    description: "test",
    price: 100,
    serviceCode: null,
    scheduledFor: null,
    serviceBrief: null,
    handoffOtpHash: null,
    handoffOtpExpiresAt: null,
    handoffVerifiedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  beforeAll(async () => {
    await harness.connect();
    const pool = await harness.freshDb("stores");

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

  afterAll(async () => {
    await harness.dropAll();
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
