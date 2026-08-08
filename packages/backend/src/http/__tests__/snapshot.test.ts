import express, { type Express } from "express";
import RedisMock from "ioredis-mock";
import request from "supertest";
import type { Server } from "socket.io";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocationUpdate, SessionSnapshot } from "@needy/shared";
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
    const res = await request(app)
      .get("/snapshot")
      .set("Authorization", `Bearer ${token}`);
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
