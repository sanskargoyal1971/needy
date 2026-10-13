import "dotenv/config";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { Server as IOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { NS, type MatchedHelper } from "@needy/shared";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { createRedisClients, type RedisClient } from "./redis.js";
import { authMiddleware } from "./socket/auth.js";
import { createSocketOnboardingGate } from "./socket/onboardingGate.js";
import { disconnectUserSockets } from "./socket/disconnect.js";
import { registerPresence } from "./socket/presence.js";
import { registerTracking } from "./socket/tracking.js";
import { registerMatching } from "./socket/matching.js";
import { registerChat } from "./socket/chat.js";
import { registerSos } from "./socket/sos.js";
import { createHttpRouter } from "./http/router.js";
import { createHandoffRouter } from "./http/handoff.js";
import { createServicesRouter } from "./http/services.js";
import type { Deps } from "./domain/deps.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "./domain/stores.js";
import { createPgRepositories } from "./domain/pgStores.js";
import { createInMemorySosRepo, createPgSosRepo } from "./domain/sosStore.js";
import {
  createInMemoryAbuseRepo,
  createPgAbuseRepo,
  type AbuseRepository,
} from "./domain/abuseStore.js";
import { createAdminRouter } from "./admin/router.js";
import { createSosAdminRouter } from "./admin/sos.js";
import { createAbuseRouter } from "./admin/abuse.js";
import {
  createInMemoryApplicationRepo,
  createPgApplicationRepo,
  type HelperApplicationRepository,
} from "./admin/repos.js";
import { createPool, seedHelperProfiles, type DbPool } from "./db.js";
import { migrate } from "./migrations.js";
import { createAuthRouter, KYC_CALLBACK_PATH, kycRawBodyParser } from "./auth/router.js";
import { csrfProtection } from "./auth/csrf.js";
import { AuthService } from "./auth/service.js";
import { OtpService } from "./auth/otp.js";
import {
  ConsoleSmsProvider,
  SandboxKycProvider,
  TwilioSmsProvider,
  type KycProvider,
  type SmsProvider,
} from "./auth/providers.js";
import {
  createInMemorySessionRepo,
  createInMemoryUserRepo,
  createPgSessionRepo,
  createPgUserRepo,
} from "./auth/repos.js";
import type { UserRepository } from "./auth/repos.js";
import type { User } from "./auth/types.js";
import {
  createInMemoryPhoneBlockRepo,
  createPgPhoneBlockRepo,
  type PhoneBlockRepository,
} from "./auth/phoneBlocks.js";
import { createOnboardingRouter } from "./onboarding/router.js";
import { createExceptionRouter } from "./onboarding/exceptionRouter.js";
import {
  createInMemoryKycDocumentRepo,
  createPgKycDocumentRepo,
  type KycDocumentRepository,
} from "./onboarding/repos.js";
import { createLoggingAuditLogger, createPgAuditLogger, type AuditLogger } from "./audit/log.js";
import { createStorageProvider } from "./services/storage.js";
import {
  createInMemoryServiceCatalog,
  createPgServiceCatalog,
  type ServiceCatalog,
} from "./services/catalog.js";
import {
  createInMemoryExceptionRepo,
  createPgExceptionRepo,
  type ExceptionRepository,
} from "./domain/exceptions.js";
import { createVerificationRouter } from "./admin/verification.js";
import { createStaffRouter } from "./admin/staff.js";
import {
  createInMemoryAdminUserQueries,
  createPgAdminUserQueries,
  type AdminUserQueries,
} from "./admin/verificationRepo.js";

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
  // Annotated rather than inferred: `listStaff` below closes over it, and an inferred `let`
  // is not resolvable at that point.
  let userRepo: UserRepository;
  let sessionRepo;
  let sosRepo;
  let applicationRepo: HelperApplicationRepository;
  let documentRepo: KycDocumentRepository;
  let phoneBlockRepo: PhoneBlockRepository;
  let audit: AuditLogger;
  let adminQueries: AdminUserQueries;
  /** Operator accounts only, for the super admin's staff screen. Narrower than a full
   *  user listing on purpose — see the note on `StaffRouterDeps.listStaff`. */
  let listStaff: () => Promise<User[]>;
  let serviceCatalog: ServiceCatalog;
  let exceptionRepo: ExceptionRepository;
  let abuseRepo: AbuseRepository;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl);
    // Versioned, advisory-locked migrations (see migrations.ts). Replaces re-executing the
    // whole DDL on every boot, which had no way to express a non-idempotent change and raced
    // itself when two instances started together during a rolling deploy.
    await migrate(pool, logger);
    // Fixture seeding OVERWRITES existing helper rows (ON CONFLICT DO UPDATE), so it must
    // never run against a real database — it would stomp live profiles on every deploy.
    if (config.allowDevRoutes) {
      await seedHelperProfiles(pool, helperSeed);
      logger.info("seeded dev helper fixtures", { env: config.env });
    }
    repos = createPgRepositories(pool);
    userRepo = createPgUserRepo(pool);
    sessionRepo = createPgSessionRepo(pool);
    sosRepo = createPgSosRepo(pool);
    applicationRepo = createPgApplicationRepo(pool);
    documentRepo = createPgKycDocumentRepo(pool);
    phoneBlockRepo = createPgPhoneBlockRepo(pool);
    audit = createPgAuditLogger(pool, () => Date.now());
    adminQueries = createPgAdminUserQueries(pool);
    listStaff = async () => {
      const { rows } = await pool!.query<{ id: string }>(
        `SELECT id FROM users WHERE role IN ('admin','super_admin')`,
      );
      const found = await Promise.all(rows.map((r) => userRepo.getById(r.id)));
      return found.filter((u): u is User => u != null);
    };
    serviceCatalog = createPgServiceCatalog(pool);
    exceptionRepo = createPgExceptionRepo(pool);
    abuseRepo = createPgAbuseRepo(pool);
    logger.info("using postgres repositories");
  } else {
    repos = {
      tasks: createInMemoryTaskRepo(),
      messages: createInMemoryMessageRepo(),
      helpers: createInMemoryHelperProfileRepo(helperSeed),
    };
    const inMemoryUsers = createInMemoryUserRepo();
    userRepo = inMemoryUsers;
    sessionRepo = createInMemorySessionRepo();
    sosRepo = createInMemorySosRepo();
    applicationRepo = createInMemoryApplicationRepo();
    documentRepo = createInMemoryKycDocumentRepo();
    phoneBlockRepo = createInMemoryPhoneBlockRepo();
    audit = createLoggingAuditLogger();
    // The in-memory admin queries read straight out of the in-memory user repo, which is the
    // only implementation that can enumerate — see the note on InMemoryUserRepository.
    adminQueries = createInMemoryAdminUserQueries(() => inMemoryUsers.all());
    listStaff = async () =>
      inMemoryUsers.all().filter((u) => u.role === "admin" || u.role === "super_admin");
    serviceCatalog = createInMemoryServiceCatalog();
    exceptionRepo = createInMemoryExceptionRepo();
    abuseRepo = createInMemoryAbuseRepo();
    if (config.isProduction) {
      // Non-durable storage in production means tasks, chat history and SOS alerts vanish
      // on restart. That is a data-loss configuration, not a degraded mode.
      throw new Error("DATABASE_URL is required in production (refusing in-memory storage)");
    }
    logger.info("DATABASE_URL unset — using in-memory repositories (non-durable)");
  }

  const now = () => Date.now();
  // Stage A — identity. Both of these selections used to be no-op ternaries that returned the
  // console/sandbox adapter on BOTH branches, so setting SMS_PROVIDER=twilio silently kept
  // logging OTPs to stdout while looking configured. Unknown providers now fail loudly, and
  // the sandbox adapters are refused outright in production.
  const smsProvider = createSmsProvider();
  const kycProvider = createKycProvider();
  const otpService = createOtpService(redis.client, smsProvider);
  const authService = new AuthService({
    users: userRepo,
    sessions: sessionRepo,
    phoneBlocks: phoneBlockRepo,
    now,
  });
  // Refuses to construct in production unless S3 is configured — see createStorageProvider.
  const storage = createStorageProvider(now);

  const deps: Deps = {
    io: undefined as unknown as IOServer, // set below once the server exists
    redis,
    logger,
    config,
    tasks: repos.tasks,
    messages: repos.messages,
    helpers: repos.helpers,
    sos: sosRepo,
    users: userRepo,
    services: serviceCatalog,
    exceptions: exceptionRepo,
    audit,
    abuse: abuseRepo,
    now,
  };

  // Reads `deps.io` when CALLED, not when defined: the routers that use this are built before
  // the Socket.io server exists, and can only be reached after it does.
  const disconnectUser = (userId: string) => disconnectUserSockets(deps.io, userId);

  // ── HTTP ───────────────────────────────────────────────────────────────────
  const app = express();
  // ── security headers ──────────────────────────────────────────────────────
  //
  // This used to be `contentSecurityPolicy: false`, with a comment arguing that a CSP on a
  // JSON API gives false assurance because the DOCUMENT's policy is what governs the browser.
  // That argument was right, and the document now has one (packages/web/src/middleware.ts).
  // With that in place, a policy here is worth setting for a different reason: it describes
  // what this origin legitimately serves, which is JSON and nothing else.
  //
  // `default-src 'none'` is therefore not a compromise policy — it is literally accurate. If a
  // response from this origin is ever rendered as a document (a reflected error page, a
  // content-type confusion, an attacker who gets bytes echoed back), nothing in it may load or
  // execute anything at all.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'none'"],
          "frame-ancestors": ["'none'"],
          "base-uri": ["'none'"],
          "form-action": ["'none'"],
        },
      },
      // Browsers ignore HSTS over plain HTTP, so this is harmless in local development and
      // load-bearing in production. `includeSubDomains` because the cookies are host-scoped
      // and a sibling subdomain served over HTTP could set one.
      hsts: { maxAge: 15_552_000, includeSubDomains: true },
      // KYC documents are served from this origin to the admin console; `same-site` lets that
      // work while refusing to let an unrelated site embed anything from here.
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  // credentials:true so the browser sends/stores the httpOnly auth cookies cross-origin.
  app.use(cors({ origin: config.corsOrigins, credentials: true }));

  // Behind a proxy or load balancer, `req.ip` is the proxy's address unless Express is told to
  // trust the forwarding headers — which would collapse the per-IP OTP limiter into a single
  // shared bucket for every user on the platform. Opt-in via env because trusting
  // X-Forwarded-For when NOT behind a proxy is worse than not trusting it: any client could
  // then spoof its own source address and sidestep the limit entirely.
  if (config.trustProxy) {
    app.set("trust proxy", config.trustProxy);
    logger.info("trusting proxy headers for client IP", { trustProxy: config.trustProxy });
  }

  // The KYC callback's HMAC is computed over the RAW request bytes, so it must be captured
  // before anything re-serializes the body — a `JSON.parse` → `JSON.stringify` round trip is
  // not byte-identical (key order, whitespace, number formatting), and the signature would
  // never match. Mounted path-scoped and BEFORE the app-wide parser; body-parser's `req._body`
  // marker then makes the general `express.json()` skip this path rather than parse it twice.
  // Deliberately narrow: disabling JSON parsing app-wide to serve one route would be a far
  // larger change than the problem warrants.
  app.use(KYC_CALLBACK_PATH, kycRawBodyParser);

  // Bound the body size: unbounded JSON parsing is a trivial memory-exhaustion vector, and
  // no endpoint here legitimately needs more than a few KB.
  app.use(express.json({ limit: "64kb" }));

  // CSRF, app-wide and BEFORE every router — a protection mounted per-router is one a new
  // router can be added without. The KYC callback is the single exemption: it authenticates
  // by HMAC over raw bytes, carries no cookie, and arrives from an origin we neither control
  // nor can enumerate. See auth/csrf.ts for why the token travels in a response body rather
  // than being read out of the cookie.
  app.use(csrfProtection({ exemptPaths: [KYC_CALLBACK_PATH] }));
  app.use(
    createAuthRouter({
      auth: authService,
      otp: otpService,
      kyc: kycProvider,
      users: userRepo,
      documents: documentRepo,
      redis: redis.client,
      abuse: abuseRepo,
      now,
    }),
  );
  app.use(
    createOnboardingRouter({
      users: userRepo,
      documents: documentRepo,
      storage,
      audit,
      now,
    }),
  );
  app.use(
    createVerificationRouter({
      users: userRepo,
      sessions: sessionRepo,
      documents: documentRepo,
      phoneBlocks: phoneBlockRepo,
      queries: adminQueries,
      services: serviceCatalog,
      storage,
      audit,
      auth: authService,
      pool,
      now,
      disconnectUser,
    }),
  );
  app.use(
    createStaffRouter({
      users: userRepo,
      sessions: sessionRepo,
      audit,
      listStaff,
      now,
      disconnectUser,
    }),
  );
  app.use(
    createAdminRouter({
      applications: applicationRepo,
      users: userRepo,
      helpers: repos.helpers,
      tasks: repos.tasks,
      now,
      pool,
    }),
  );
  // Pass the pool so GET /health actually probes Postgres. `pool` is null in in-memory mode,
  // which the router reports as "not-configured" rather than treating as a failure.
  app.use(
    createExceptionRouter({
      users: userRepo,
      exceptions: exceptionRepo,
      storage,
      audit,
      now,
    }),
  );
  // The safety consoles. Both read `deps.io` to fan changes back out over the socket, so they
  // are mounted here but only become live once `deps.io` is assigned below — which is fine,
  // since neither can be reached before the server is listening.
  app.use(createSosAdminRouter(deps));
  app.use(createAbuseRouter(deps));
  app.use(createServicesRouter(deps));
  app.use(createHandoffRouter(deps));
  app.use(createHttpRouter(deps, pool ? { db: pool } : {}));

  const httpServer = createServer(app);

  // ── Socket.io ────────────────────────────────────────────────────────────
  const io = new IOServer(httpServer, {
    cors: { origin: config.corsOrigins },
    // CORS does not apply to a WebSocket upgrade — a browser will open one to any origin and
    // attach whatever cookies it is allowed to. SameSite=Strict is what currently stops a
    // hostile page riding a signed-in user's session; this is the second lock, so that
    // protection does not rest on one cookie attribute. A request with NO Origin is not a
    // browser (the dev scripts, tests, a future native app) and carries no ambient cookie.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      const allowed = origin == null || config.corsOrigins.includes(origin);
      if (!allowed)
        logger.warn("refused a socket handshake from an unrecognised origin", { origin });
      callback(null, allowed);
    },
  });
  deps.io = io;

  // Redis adapter so presence/matching/tracking broadcasts fan out across instances.
  io.adapter(createAdapter(redis.pub, redis.sub));

  // Authenticate every namespace handshake with the same short-lived JWT as REST (§2.1),
  // then require an approved account before any of them will carry traffic.
  //
  // The gate has to be here and not only on POST /tasks: accepting an offer, chatting and
  // publishing a location all travel over Socket.io, so gating the REST route alone would
  // leave an unapproved helper able to accept work by connecting to /matching directly.
  const socketOnboardingGate = createSocketOnboardingGate(userRepo);
  for (const ns of Object.values(NS)) {
    io.of(ns).use(authMiddleware);
    io.of(ns).use(socketOnboardingGate);
  }

  // Wire each concern onto its namespace. Order is irrelevant — they never touch each other.
  registerPresence(deps);
  registerTracking(deps);
  registerMatching(deps);
  registerChat(deps);
  registerSos(deps);

  httpServer.listen(config.port, () => {
    logger.info("needy backend up", {
      port: config.port,
      namespaces: Object.values(NS),
    });
  });

  // Graceful shutdown. The original called io.close()/httpServer.close() WITHOUT awaiting
  // their callbacks and then exited immediately, so in-flight requests and socket writes were
  // cut off mid-flight and Redis/pg cleanup raced the exit. Now each stage is awaited, with a
  // hard timeout so a wedged connection can't leave the process hanging forever.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // a second ^C must not re-enter and double-close
    shuttingDown = true;
    logger.info("shutting down", { signal });

    const closeAll = (async () => {
      // io.close() also closes the underlying HTTP server it was attached to.
      //
      // Awaited DIRECTLY, not wrapped in `new Promise(r => io.close(() => r()))`. socket.io 4's
      // close() is itself async: it disconnects every socket and awaits each namespace's
      // `adapter.close()` — the Redis adapter's unsubscribe — and only THEN closes the HTTP
      // server, whose callback is what the wrapper resolved on. So the wrapper both discarded a
      // promise (the `no-misused-promises` finding) and, in the case that matters, resolved on
      // the *inner* callback while the adapter teardown was still in flight. Awaiting the
      // returned promise is the only form that actually waits for the whole sequence, which is
      // the entire point of the comment above.
      await io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await Promise.allSettled([
        redis.client.quit(),
        redis.pub.quit(),
        redis.sub.quit(),
        ...(pool ? [pool.end()] : []),
      ]);
    })();

    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 10_000).unref?.(),
    );
    const outcome = await Promise.race([closeAll.then(() => "closed" as const), timeout]);
    if (outcome === "timeout") {
      logger.warn("shutdown timed out after 10s — exiting anyway");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // An unhandled rejection previously left the process in an undefined state silently. Log
  // loudly; do NOT exit, since a single failed Redis command must not take down every live
  // task, tracking session and chat on the instance.
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled promise rejection", { err: reason });
  });
}

/**
 * Build the OTP service, honouring the development fixed code.
 *
 * `OtpService` already took an injectable generator so tests could be deterministic; this uses
 * the same seam for the same reason at a larger scale, while there is no SMS provider and every
 * sign-in otherwise means reading a random code out of a log file.
 *
 * The production check is the important half. A fixed code means a phone number IS an account:
 * anyone who knows a helper's number can sign in as that helper, read their chats, see the
 * requester's address and raise or stand down an alarm. So this does not warn and continue —
 * it refuses to construct, and the process fails to start. A guard that can be ignored is one
 * that will be.
 */
function createOtpService(redis: RedisClient, sms: SmsProvider): OtpService {
  const fixed = config.auth.devFixedOtp;
  if (!fixed) return new OtpService(redis, sms, config.auth.otp);

  if (config.isProduction) {
    throw new Error(
      "DEV_FIXED_OTP is set in production. Every account would share one passcode. Unset it.",
    );
  }
  if (!new RegExp(`^\\d{${config.auth.otp.length}}$`).test(fixed)) {
    throw new Error(`DEV_FIXED_OTP must be ${config.auth.otp.length} digits, got "${fixed}".`);
  }

  // Loud, every boot, and at warn so it survives a log level that hides info. Someone reading
  // the startup output of a shared environment should not have to go looking for this.
  logger.warn(
    "DEVELOPMENT: every account accepts the same one-time code. Anyone who knows a phone " +
      "number can sign in as that person. Remove DEV_FIXED_OTP once SMS is configured.",
    { code: fixed },
  );
  return new OtpService(redis, sms, config.auth.otp, () => fixed);
}

/** Select the SMS adapter. A misconfigured provider name must not silently degrade to
 *  logging one-time codes to stdout — that is a credential-disclosure path dressed up as a
 *  working config, so an unrecognised value is a boot failure. */
function createSmsProvider(): SmsProvider {
  switch (config.auth.smsProvider) {
    case "console":
      return new ConsoleSmsProvider();
    case "twilio": {
      // Validated here rather than in config.ts because these are only required when this
      // branch is selected. Refusing at boot beats discovering it on the first login attempt.
      const { accountSid, authToken, from } = config.auth.twilio;
      const missing = [
        !accountSid && "TWILIO_ACCOUNT_SID",
        !authToken && "TWILIO_AUTH_TOKEN",
        !from && "TWILIO_FROM",
      ].filter(Boolean);
      if (missing.length > 0) {
        throw new Error(`SMS_PROVIDER=twilio requires ${missing.join(", ")}`);
      }
      return new TwilioSmsProvider({ accountSid, authToken, from });
    }
    default:
      throw new Error(`unknown SMS_PROVIDER: ${config.auth.smsProvider}`);
  }
}

/** Select the KYC adapter. Same reasoning: the sandbox provider verifies on demand, so it
 *  must never be reachable in production. */
function createKycProvider(): KycProvider {
  switch (config.auth.kycProvider) {
    case "sandbox":
      if (config.isProduction) {
        throw new Error(
          "KYC_PROVIDER=sandbox is refused in production (it approves verification without any real check)",
        );
      }
      return new SandboxKycProvider();
    case "signzy":
    case "hyperverge":
    case "digilocker":
      throw new Error(
        `KYC_PROVIDER=${config.auth.kycProvider} is not implemented yet — no adapter exists in auth/providers.ts`,
      );
    default:
      throw new Error(`unknown KYC_PROVIDER: ${config.auth.kycProvider}`);
  }
}

main().catch((err) => {
  logger.error("fatal boot error", { err });
  process.exit(1);
});
