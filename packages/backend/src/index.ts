import "dotenv/config";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server as IOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { NS, type MatchedHelper } from "@needy/shared";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { createRedisClients } from "./redis.js";
import { authMiddleware } from "./socket/auth.js";
import { registerPresence } from "./socket/presence.js";
import { registerTracking } from "./socket/tracking.js";
import { registerMatching } from "./socket/matching.js";
import { registerChat } from "./socket/chat.js";
import { createHttpRouter } from "./http/router.js";
import type { Deps } from "./domain/deps.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "./domain/stores.js";
import { createPgRepositories } from "./domain/pgStores.js";
import { createPool, runMigrations, seedHelperProfiles, type DbPool } from "./db.js";
import { createAuthRouter } from "./auth/router.js";
import { AuthService } from "./auth/service.js";
import { OtpService } from "./auth/otp.js";
import { ConsoleSmsProvider, SandboxKycProvider } from "./auth/providers.js";
import {
  createInMemorySessionRepo,
  createInMemoryUserRepo,
  createPgSessionRepo,
  createPgUserRepo,
} from "./auth/repos.js";

/** Composition root: build the Deps container, wire the HTTP + socket layers, and start.
 *  Everything above this file depends only on interfaces — this is the one place the
 *  concrete implementations (Redis, in-memory repos, real clock) get chosen. */
async function main(): Promise<void> {
  const redis = createRedisClients();

  // Dev-seed a couple of KYC-verified-style helper profiles so a matched reveal has real
  // data to render before a profile service exists. Swap for a Postgres-backed repo later.
  const helperSeed: Record<string, Omit<MatchedHelper, "etaSeconds">> = {
    "helper-priya": {
      id: "helper-priya",
      displayName: "Priya",
      photoUrl: "",
      rating: 4.9,
      helpedCount: 34,
    },
  };

  // Durable repositories when a database is configured; otherwise in-memory (dev / no-pg).
  // Both satisfy the same interfaces, so nothing downstream cares which is chosen.
  let pool: DbPool | null = null;
  let repos;
  let userRepo;
  let sessionRepo;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl);
    await runMigrations(pool);
    await seedHelperProfiles(pool, helperSeed);
    repos = createPgRepositories(pool);
    userRepo = createPgUserRepo(pool);
    sessionRepo = createPgSessionRepo(pool);
    logger.info("using postgres repositories");
  } else {
    repos = {
      tasks: createInMemoryTaskRepo(),
      messages: createInMemoryMessageRepo(),
      helpers: createInMemoryHelperProfileRepo(helperSeed),
    };
    userRepo = createInMemoryUserRepo();
    sessionRepo = createInMemorySessionRepo();
    logger.info("DATABASE_URL unset — using in-memory repositories (non-durable)");
  }

  const now = () => Date.now();
  // Stage A — identity. Providers are sandbox adapters here (see auth/providers.ts); a real
  // deployment swaps in Twilio + a licensed eKYC provider via config with no other changes.
  const smsProvider =
    config.auth.smsProvider === "console" ? new ConsoleSmsProvider() : new ConsoleSmsProvider();
  const kycProvider =
    config.auth.kycProvider === "sandbox" ? new SandboxKycProvider() : new SandboxKycProvider();
  const otpService = new OtpService(redis.client, smsProvider, config.auth.otp);
  const authService = new AuthService({ users: userRepo, sessions: sessionRepo, now });

  const deps: Deps = {
    io: undefined as unknown as IOServer, // set below once the server exists
    redis,
    logger,
    config,
    tasks: repos.tasks,
    messages: repos.messages,
    helpers: repos.helpers,
    now,
  };

  // ── HTTP ───────────────────────────────────────────────────────────────────
  const app = express();
  // credentials:true so the browser sends/stores the httpOnly auth cookies cross-origin.
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json());
  app.use(
    createAuthRouter({
      auth: authService,
      otp: otpService,
      kyc: kycProvider,
      users: userRepo,
      redis: redis.client,
      now,
    }),
  );
  app.use(createHttpRouter(deps));

  const httpServer = createServer(app);

  // ── Socket.io ────────────────────────────────────────────────────────────
  const io = new IOServer(httpServer, {
    cors: { origin: config.corsOrigin },
  });
  deps.io = io;

  // Redis adapter so presence/matching/tracking broadcasts fan out across instances.
  io.adapter(createAdapter(redis.pub, redis.sub));

  // Authenticate every namespace handshake with the same short-lived JWT as REST (§2.1).
  for (const ns of Object.values(NS)) {
    io.of(ns).use(authMiddleware);
  }

  // Wire each concern onto its namespace. Order is irrelevant — they never touch each other.
  registerPresence(deps);
  registerTracking(deps);
  registerMatching(deps);
  registerChat(deps);

  httpServer.listen(config.port, () => {
    logger.info("needy backend up", {
      port: config.port,
      namespaces: Object.values(NS),
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    io.close();
    httpServer.close();
    await Promise.allSettled([
      redis.client.quit(),
      redis.pub.quit(),
      redis.sub.quit(),
      ...(pool ? [pool.end()] : []),
    ]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("fatal boot error", { err: String(err) });
  process.exit(1);
});
