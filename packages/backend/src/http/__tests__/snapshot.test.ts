import express, { type Express } from "express";
import RedisMock from "ioredis-mock";
import request from "supertest";
import type { Server } from "socket.io";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryServiceCatalog } from "../../services/catalog.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { safetyDeps } from "../../test/safetyDeps.js";
import { makeSosAlert, makeTask, type LocationUpdate, type SessionSnapshot } from "@needy/shared";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import type { Deps } from "../../domain/deps.js";
import type { RedisClients } from "../../redis.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { setTaskLocation } from "../../domain/location-store.js";
import { createHttpRouter } from "../router.js";
import { makeUser } from "../../auth/types.js";

/** §2.1 — the reconnect SNAPSHOT endpoint is the authoritative post-drop truth. This test
 *  drives it end-to-end over HTTP: mint a token, open a task, promote it to a matched +
 *  en-route state (helper profile + live location), then re-sync via GET /snapshot exactly
 *  as a reconnecting client would. */

const HELPER_ID = "helper-1";
// Fixed clock so ETA/serverTime are deterministic (the injectable seam on Deps).
const NOW = 1_700_000_000_000;

// The /snapshot router never touches deps.io; a stub keeps the container well-typed
// without standing up a real socket.io server (and its open handles) for a REST test.
const io = {} as unknown as Server;

let app: Express;
let redis: RedisClients;
let deps: Deps;

/** Seed a helper profile so the reveal card (MatchedHelper) can be populated on match. */
/** POST /tasks is behind `requireOnboarded`, which reads the user row rather than the JWT so
 *  a reviewer's decision takes effect immediately rather than at token expiry. The dev token
 *  alone is therefore no longer sufficient — the account has to exist and be approved. */
const users = createInMemoryUserRepo();

const helpers = createInMemoryHelperProfileRepo({
  [HELPER_ID]: {
    id: HELPER_ID,
    displayName: "Priya",
    photoUrl: "https://example.test/priya.jpg",
    rating: 4.9,
    helpedCount: 42,
  },
});

beforeAll(async () => {
  await users.create(
    makeUser({
      dateOfBirth: "1985-06-15",
      gender: "male",
      id: "requester-1",
      phone: "+919000000900",
      displayName: "Alex",
      onboardingStatus: "approved",
    }),
  );

  const client = new RedisMock();
  redis = {
    client,
    pub: client.duplicate(),
    sub: client.duplicate(),
  } as unknown as RedisClients;

  deps = {
    io,
    redis,
    logger,
    config,
    tasks: createInMemoryTaskRepo(),
    messages: createInMemoryMessageRepo(),
    helpers,
    // Unused by /snapshot, but the container is a single shape and a partial one would only
    // typecheck by casting — which is how a missing dependency stays invisible until runtime.
    sos: createInMemorySosRepo(),
    users,
    services: createInMemoryServiceCatalog(),
    exceptions: createInMemoryExceptionRepo(),
    ...safetyDeps(),
    now: () => NOW,
  };

  app = express();
  app.use(express.json());
  app.use("/", createHttpRouter(deps));
});

afterAll(async () => {
  await redis.client.quit();
  await redis.pub.quit();
  await redis.sub.quit();
});

describe("GET /snapshot (§2.1 reconnect)", () => {
  it("returns the full authoritative session for a matched, en-route task", async () => {
    // 1. Mint a requester access token via the dev endpoint.
    const tokenRes = await request(app)
      .post("/dev/token")
      .send({ userId: "requester-1", role: "requester", displayName: "Alex" });
    expect(tokenRes.status).toBe(200);
    const token: string = tokenRes.body.token;
    expect(typeof token).toBe("string");

    // 2. Open a task (starts in "searching").
    const origin = { lat: 12.9611, lng: 77.6387 };
    const createRes = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "errand", title: "Pick up medicine", description: "test", origin });
    expect(createRes.status).toBe(201);
    const taskId: string = createRes.body.id;

    // 3. Simulate a match + en-route promotion by driving the repo directly.
    await deps.tasks.update(taskId, { helperId: HELPER_ID, state: "en-route" });

    // 4. Record the helper's current live position for this task (feeds lastKnownLocation + ETA).
    const location: LocationUpdate = {
      lat: 12.9652,
      lng: 77.6421,
      heading: 210,
      speedMps: 1.5,
      at: NOW,
    };
    await setTaskLocation(redis.client, taskId, location);

    // 5. Re-sync exactly as a reconnecting client would.
    const res = await request(app).get("/snapshot").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const snapshot = res.body as SessionSnapshot;
    expect(snapshot.userId).toBe("requester-1");
    expect(snapshot.serverTime).toBe(NOW);
    expect(snapshot.activeTasks).toHaveLength(1);

    const [snap] = snapshot.activeTasks;
    // The task itself is present and reflects the en-route promotion.
    expect(snap.task.id).toBe(taskId);
    expect(snap.task.state).toBe("en-route");
    expect(snap.task.helperId).toBe(HELPER_ID);

    // Helper reveal card is populated with the seeded profile + a live ETA.
    expect(snap.helper).not.toBeNull();
    expect(snap.helper!.id).toBe(HELPER_ID);
    expect(snap.helper!.displayName).toBe("Priya");
    expect(snap.helper!.etaSeconds).not.toBeNull();

    // Live location the client can place the marker from immediately.
    expect(snap.lastKnownLocation).not.toBeNull();
    expect(snap.lastKnownLocation!.lat).toBe(location.lat);
    expect(snap.lastKnownLocation!.lng).toBe(location.lng);

    // ETA is non-null with sane fields.
    expect(snap.eta).not.toBeNull();
    expect(typeof snap.eta!.etaSeconds).toBe("number");
    expect(typeof snap.eta!.distanceMeters).toBe("number");

    // Messages is always an array (empty here — no chat yet).
    expect(Array.isArray(snap.messages)).toBe(true);
    expect(snap.messages).toHaveLength(0);

    // No alarm on this task, and the field is present and null rather than absent.
    expect(snap.sos).toBeNull();
  });

  /**
   * A live alarm must survive a reload.
   *
   * `sos-raised` fires once, at the moment of the alarm. A client that reloaded — or whose
   * phone dropped the socket, which is not unlikely in the situations this button exists for —
   * rebuilt itself from the snapshot, and the snapshot did not carry the alert. So the screen
   * came back showing an un-pressed alarm button over a live emergency, and the other party's
   * warning that their companion was in trouble disappeared with it.
   *
   * `SosRepository.activeForTask` was written for exactly this and its own comment said so;
   * nothing called it until now.
   */
  it("carries a live alarm so a reloading client does not lose it", async () => {
    const token: string = (
      await request(app)
        .post("/dev/token")
        .send({ userId: "requester-1", role: "requester", displayName: "Alex" })
    ).body.token;

    const task = await deps.tasks.create(
      makeTask({
        id: "alarm-task",
        requesterId: "requester-1",
        helperId: HELPER_ID,
        category: "errand",
        state: "in-progress",
        origin: { lat: 12.9611, lng: 77.6387 },
        title: "Alarm raised mid-task",
      }),
    );
    const alert = await deps.sos.create(
      makeSosAlert({
        id: "alarm-1",
        taskId: task.id,
        raisedBy: "requester-1",
        kind: "unsafe",
        createdAt: NOW,
      }),
    );

    const res = await request(app).get("/snapshot").set("Authorization", `Bearer ${token}`);
    const found = (res.body as SessionSnapshot).activeTasks.find((t) => t.task.id === task.id);
    expect(found?.sos).not.toBeNull();
    expect(found!.sos!.id).toBe(alert.id);
    // Carries who raised it, which is what lets each screen tell "my alarm" from "theirs" —
    // the other party may not withdraw one, so it must not be offered to them.
    expect(found!.sos!.raisedBy).toBe("requester-1");
    expect(found!.sos!.status).toBe("raised");
  });

  /**
   * The handoff credential must not come back out of a read endpoint.
   *
   * This is the test that was missing, and its absence hid a real defect: `buildTaskSnapshot`
   * returned the stored task verbatim, so a helper reconnecting mid-handoff received the
   * SHA-256 of the live code. Six digits is a million candidates — recovering the code from
   * the digest is a fraction of a second of work — so the helper could have typed in a number
   * the requester never read aloud, from anywhere. That is the entire presence property of the
   * doorstep handoff, defeated by the reconnect path.
   *
   * Asserted from the HELPER's session deliberately: they are the party the control is aimed
   * at, and the one with a legitimate reason to call both of these endpoints.
   */
  it("never returns the handoff code hash to either party", async () => {
    const helperToken: string = (
      await request(app)
        .post("/dev/token")
        .send({ userId: HELPER_ID, role: "helper", displayName: "Priya" })
    ).body.token;
    const requesterToken: string = (
      await request(app)
        .post("/dev/token")
        .send({ userId: "requester-1", role: "requester", displayName: "Alex" })
    ).body.token;

    const created = await deps.tasks.create(
      makeTask({
        id: "leak-task",
        requesterId: "requester-1",
        helperId: HELPER_ID,
        category: "errand",
        state: "arrived",
        origin: { lat: 12.9611, lng: 77.6387 },
        title: "At the door",
      }),
    );
    // Exactly the state the reveal endpoint leaves behind: a live code, un-entered.
    await deps.tasks.update(created.id, {
      handoffOtpHash: "a".repeat(64),
      handoffOtpExpiresAt: NOW + 60_000,
    });

    for (const [who, token] of [
      ["helper", helperToken],
      ["requester", requesterToken],
    ] as const) {
      const detail = await request(app)
        .get(`/tasks/${created.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(detail.status, who).toBe(200);
      expect(detail.body.task, who).not.toHaveProperty("handoffOtpHash");
      expect(detail.body.task, who).not.toHaveProperty("handoffOtpExpiresAt");
      // The rest of the task still arrives — stripping the credential must not cost the
      // screen the fields it renders from.
      expect(detail.body.task.state, who).toBe("arrived");

      const snap = await request(app).get("/snapshot").set("Authorization", `Bearer ${token}`);
      expect(snap.status, who).toBe(200);
      const found = (snap.body as SessionSnapshot).activeTasks.find(
        (t) => t.task.id === created.id,
      );
      expect(found, who).toBeDefined();
      expect(found!.task, who).not.toHaveProperty("handoffOtpHash");
      expect(found!.task, who).not.toHaveProperty("handoffOtpExpiresAt");
    }
  });

  it("returns 401 without a valid bearer token", async () => {
    const noHeader = await request(app).get("/snapshot");
    expect(noHeader.status).toBe(401);

    const badToken = await request(app)
      .get("/snapshot")
      .set("Authorization", "Bearer not-a-real-token");
    expect(badToken.status).toBe(401);
  });
});

describe("POST /tasks — who may ask for help", () => {
  const origin = { lat: 12.9611, lng: 77.6387 };
  const body = { category: "errand", title: "Pick up medicine", description: "test", origin };

  /** The token claims `requester` in every case. The refusal has to come from the account's
   *  stored role, not from a claim the caller's token happens to carry. */
  const tokenFor = async (userId: string): Promise<string> => {
    const res = await request(app)
      .post("/dev/token")
      .send({ userId, role: "requester", displayName: userId });
    return res.body.token as string;
  };

  it.each([
    ["helper", "role-helper-only"],
    ["admin", "role-admin"],
    ["super_admin", "role-super-admin"],
  ] as const)("refuses an approved %s account", async (role, id) => {
    await users.create(
      makeUser({
        id,
        phone: `+9190000009${id.length}${role.length}`,
        displayName: id,
        role,
        onboardingStatus: "approved",
        ...(role === "super_admin" ? { username: "root-test" } : {}),
      }),
    );
    const res = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${await tokenFor(id)}`)
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
    expect(await deps.tasks.activeForUser(id)).toHaveLength(0);
  });

  it("allows an account that is both a requester and a helper", async () => {
    await users.create(
      makeUser({
        id: "role-both",
        phone: "+919000000955",
        displayName: "Both",
        role: "both",
        onboardingStatus: "approved",
      }),
    );
    const res = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${await tokenFor("role-both")}`)
      .send(body);
    expect(res.status).toBe(201);
  });
});
