import express, { type Express } from "express";
import RedisMock from "ioredis-mock";
import request from "supertest";
import type { Server } from "socket.io";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryServiceCatalog } from "../../services/catalog.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { safetyDeps } from "../../test/safetyDeps.js";
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
import { signAccessToken } from "../../auth/jwt.js";
import { makeUser } from "../../auth/types.js";
import { createHttpRouter, MAX_OPEN_REQUESTS } from "../router.js";

/** The create-task rate limit bounded how FAST requests opened, never how many were open at
 *  once: ten could all be searching together, each fanning offers out to every helper nearby.
 *  A person gets a few open at a time; a closed one frees its slot. */

let app: Express;
let redis: RedisClients;
let deps: Deps;
const bearer = `Bearer ${signAccessToken({ sub: "open-req", role: "requester", displayName: "R" })}`;
const body = {
  category: "errand",
  origin: { lat: 12.97, lng: 77.59 },
  title: "help",
  description: "test",
};

beforeAll(async () => {
  const users = createInMemoryUserRepo();
  await users.create(
    makeUser({
      id: "open-req",
      phone: "+919000000901",
      displayName: "R",
      dateOfBirth: "1985-06-15",
      gender: "male",
      onboardingStatus: "approved",
    }),
  );
  const client = new RedisMock();
  redis = { client, pub: client.duplicate(), sub: client.duplicate() } as unknown as RedisClients;
  deps = {
    io: {} as unknown as Server,
    redis,
    logger,
    config,
    tasks: createInMemoryTaskRepo(),
    messages: createInMemoryMessageRepo(),
    helpers: createInMemoryHelperProfileRepo({}),
    sos: createInMemorySosRepo(),
    users,
    services: createInMemoryServiceCatalog(),
    exceptions: createInMemoryExceptionRepo(),
    ...safetyDeps(),
    now: () => Date.now(),
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

describe("POST /tasks: open requests per person", () => {
  it(`allows ${MAX_OPEN_REQUESTS} open at once, refuses the next, and frees a slot on close`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_REQUESTS; i++) {
      const res = await request(app).post("/tasks").set("Authorization", bearer).send(body);
      expect(res.status, `request ${i + 1}`).toBeLessThan(300);
      ids.push(res.body.id ?? res.body.task?.id);
    }

    const refused = await request(app).post("/tasks").set("Authorization", bearer).send(body);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "too-many-open-requests", maxOpen: MAX_OPEN_REQUESTS });

    await deps.tasks.update(ids[0]!, { state: "cancelled", updatedAt: Date.now() });
    const again = await request(app).post("/tasks").set("Authorization", bearer).send(body);
    expect(again.status).toBeLessThan(300);
  });
});
