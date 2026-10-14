import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type pg from "pg";
import request from "supertest";
import { Redis } from "ioredis";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  makeSosAlert,
  makeTask,
  NS,
  type SosAlert,
  type SosClientEvents,
  type SosServerEvents,
} from "@needy/shared";
import { createSosAdminRouter } from "../../admin/sos.js";
import type { AuditEntry, AuditLogger } from "../../audit/log.js";
import { signAccessToken } from "../../auth/jwt.js";
import type { SmsProvider } from "../../auth/providers.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { makeUser, type Role } from "../../auth/types.js";
import { config, parseOncallTiers, type Config } from "../../config.js";
import { createInMemoryAbuseRepo } from "../../domain/abuseStore.js";
import type { Deps } from "../../domain/deps.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { keys } from "../../domain/keys.js";
import {
  assertSosEscalationReachable,
  escalationMessage,
  isEscalationTooLate,
  nextEscalationDue,
  participantSosView,
  scheduleSosEscalation,
  TOP_TIER_REPEATS,
} from "../../domain/sosEscalation.js";
import {
  createInMemorySosRepo,
  createPgSosRepo,
  type SosRepository,
} from "../../domain/sosStore.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
} from "../../domain/stores.js";
import type { Logger } from "../../logger.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import { createInMemoryServiceCatalog } from "../../services/catalog.js";
import { PgHarness } from "../../test/pgHarness.js";
import { authMiddleware } from "../auth.js";
import { registerSos } from "../sos.js";
import { createSosEscalationSweep } from "../sosEscalationSweep.js";

/**
 * ── SOS ESCALATION ───────────────────────────────────────────────────────────
 *
 * Before this, an alarm nobody acknowledged sat on the console and nothing else happened. Every
 * case below would fail against that code simply because there was no sweep — but the ones that
 * pin a PROPERTY, rather than the feature's existence, are:
 *
 *   - an acknowledged alarm is never paged, even when the schedule entry survived the ack;
 *   - two sweeps racing page each step exactly once (both the Redis claim and the Postgres
 *     compare-and-set are exercised, the second against a real database);
 *   - a new sweep instance — a restart — continues the ladder, including when Redis lost the
 *     schedule entirely;
 *   - the page carries no phone number, address, position or free-text note.
 *
 * REAL REDIS on db 15 under a per-run prefix, deleted in `afterAll` — never `flushdb`. The
 * clock is injected and only ever moved by hand, so nothing here depends on wall time.
 */

const REDIS_DB = 15;
const KEY_PREFIX = `test:sos-escalation:${process.pid}:${Date.now()}:`;
const T0 = 1_700_000_000_000;

// Synthetic numbers in the same reserved-looking range the other suites use.
const TIER1 = ["+919000009101", "+919000009102"];
const TIER2 = ["+919000009201"];
const REQUESTER_PHONE = "+919000009001";
const HELPER_PHONE = "+919000009002";

const ESC_CONFIG = {
  ...config,
  sos: {
    escalateAfterSeconds: 60,
    escalationStepsSeconds: [120, 300],
    oncallTiers: [TIER1, TIER2],
    maxLatenessSeconds: 3600,
    consoleOrigin: "https://console.needy.test",
  },
} as Config;

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function recordingAudit(): AuditLogger & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}

function recordingLogger(): Logger & { errors: { msg: string; meta?: Record<string, unknown> }[] } {
  const errors: { msg: string; meta?: Record<string, unknown> }[] = [];
  return { ...silentLogger, errors, error: (msg, meta) => void errors.push({ msg, meta }) };
}

/** The same client with its NEXT `zadd` rejected, as a Redis that dropped the connection would.
 *  Everything else — the claim script included — goes through untouched. */
function zaddFailsOnce(client: RedisClient): RedisClient {
  let failed = false;
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "zadd" && !failed) {
        return async () => {
          failed = true;
          throw new Error("Connection is closed.");
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Records what would have gone out. `failFor` makes a number's carrier refuse it. */
function recordingSms(failFor: string[] = []): SmsProvider & {
  sent: { phone: string; body: string }[];
} {
  const sent: { phone: string; body: string }[] = [];
  return {
    sent,
    async send(phone, body) {
      if (failFor.includes(phone)) throw new Error("carrier refused");
      sent.push({ phone, body });
    },
  };
}

describe("SOS escalation sweep", () => {
  let redisRaw: Redis;
  let redis: RedisClients;
  let io: IOServer;
  let clock = T0;
  let sos: SosRepository;
  let audit: ReturnType<typeof recordingAudit>;

  function depsWith(over: Partial<Deps> = {}): Deps {
    return {
      io,
      redis,
      logger: silentLogger,
      config: ESC_CONFIG,
      tasks: createInMemoryTaskRepo(),
      messages: createInMemoryMessageRepo(),
      helpers: createInMemoryHelperProfileRepo(),
      sos,
      users: createInMemoryUserRepo(),
      services: createInMemoryServiceCatalog(),
      exceptions: createInMemoryExceptionRepo(),
      audit,
      abuse: createInMemoryAbuseRepo(),
      now: () => clock,
      ...over,
    };
  }

  /** Raise an alert the way the socket handler does: persist, then arm the schedule. */
  async function raiseAt(id: string, at: number, extra: Partial<SosAlert> = {}): Promise<void> {
    await sos.create(
      makeSosAlert({
        id,
        taskId: `task-${id}`,
        raisedBy: "req-esc",
        kind: "medical",
        createdAt: at,
        updatedAt: at,
        ...extra,
      }),
    );
    await scheduleSosEscalation(redis.client, silentLogger, id, at + 60_000);
  }

  const scheduled = (id: string) => redis.client.zscore(keys.sosEscalationQueue(), id);

  beforeAll(() => {
    redisRaw = new Redis(config.redisUrl, { db: REDIS_DB, keyPrefix: KEY_PREFIX });
    const client = redisRaw as unknown as RedisClient;
    redis = { client, pub: client, sub: client } as unknown as RedisClients;
    // Never listens: the sweep only needs somewhere to emit `sos-updated`.
    io = new IOServer();
  });

  afterAll(async () => {
    // `io` was never attached to a server, so there is nothing to close.
    const found = await redisRaw.keys(`${KEY_PREFIX}*`);
    if (found.length > 0) await redisRaw.del(...found.map((k) => k.slice(KEY_PREFIX.length)));
    redisRaw.disconnect();
  });

  beforeEach(async () => {
    clock = T0;
    sos = createInMemorySosRepo();
    audit = recordingAudit();
    await redis.client.del(keys.sosEscalationQueue());
  });

  it("pages the first tier once the threshold passes, and not before", async () => {
    const sms = recordingSms();
    const sweep = createSosEscalationSweep(depsWith(), { sms });
    await raiseAt("a-threshold", T0);

    clock = T0 + 59_999;
    await sweep.sweepOnce();
    expect(sms.sent).toHaveLength(0);

    clock = T0 + 60_000;
    await sweep.sweepOnce();
    expect(sms.sent.map((s) => s.phone).sort()).toEqual([...TIER1].sort());

    const alert = await sos.get("a-threshold");
    expect(alert).toMatchObject({ escalationStep: 1, escalationTier: 1, escalatedAt: T0 + 60_000 });

    const rows = audit.entries.filter((e) => e.action === "sos.escalated");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: null,
      subjectType: "sos",
      subjectId: "a-threshold",
      metadata: { step: 1, tier: 1, recipients: 2, delivered: 2, final: false },
    });
    // Counts, never the numbers.
    expect(JSON.stringify(rows[0])).not.toMatch(/\+91900000\d{4}/);
  });

  it("does not page an alarm an operator acknowledged — even if the schedule entry survived", async () => {
    const sms = recordingSms();
    const sweep = createSosEscalationSweep(depsWith(), { sms });
    await raiseAt("a-acked", T0);
    await sos.acknowledge("a-acked", "op-1", T0 + 10_000);
    // Deliberately NOT unscheduled: the admin route's ZREM failing (or racing the sweep) must
    // still not wake anybody. The guarded write is what refuses it.
    expect(await scheduled("a-acked")).not.toBeNull();

    clock = T0 + 10 * 60_000;
    await sweep.sweepOnce();

    expect(sms.sent).toHaveLength(0);
    expect((await sos.get("a-acked"))!.escalationStep).toBe(0);
    expect(await scheduled("a-acked")).toBeNull();
    expect(audit.entries).toHaveLength(0);
  });

  it("stops between tiers when acknowledged mid-ladder", async () => {
    const sms = recordingSms();
    const sweep = createSosEscalationSweep(depsWith(), { sms });
    await raiseAt("a-mid", T0);
    clock = T0 + 60_000;
    await sweep.sweepOnce();
    expect(sms.sent).toHaveLength(2);

    await sos.acknowledge("a-mid", "op-1", clock + 1_000);
    clock = T0 + 60 * 60_000;
    await sweep.sweepOnce();
    expect(sms.sent).toHaveLength(2);
  });

  it("climbs the tiers at the configured intervals, repeats the top tier, then stops", async () => {
    const sms = recordingSms();
    const sweep = createSosEscalationSweep(depsWith(), { sms });
    await raiseAt("a-ladder", T0);

    // Step 1 at +60 s → tier 1.
    clock = T0 + 60_000;
    await sweep.sweepOnce();
    expect(sms.sent).toHaveLength(2);

    // Step 2 is due 120 s later (first interval). One ms early pages nobody.
    clock = T0 + 60_000 + 120_000 - 1;
    await sweep.sweepOnce();
    expect(sms.sent).toHaveLength(2);
    clock += 1;
    await sweep.sweepOnce();
    expect(sms.sent.slice(2).map((s) => s.phone)).toEqual(TIER2);
    expect(await sos.get("a-ladder")).toMatchObject({ escalationStep: 2, escalationTier: 2 });

    // Then the LAST interval (300 s) repeats, re-paging the top tier TOP_TIER_REPEATS times.
    for (let i = 0; i < TOP_TIER_REPEATS; i++) {
      clock += 300_000;
      await sweep.sweepOnce();
    }
    const alert = (await sos.get("a-ladder"))!;
    expect(alert.escalationStep).toBe(2 + TOP_TIER_REPEATS);
    expect(alert.escalationTier).toBe(2);
    expect(sms.sent).toHaveLength(2 + 1 + TOP_TIER_REPEATS);

    // Exhausted: nothing left scheduled and nothing more sent.
    expect(await scheduled("a-ladder")).toBeNull();
    clock += 60 * 60_000;
    await sweep.sweepOnce();
    expect(sms.sent).toHaveLength(2 + 1 + TOP_TIER_REPEATS);
    const steps = audit.entries.filter((e) => e.action === "sos.escalated");
    expect(steps.map((e) => (e.metadata as { tier: number }).tier)).toEqual([1, 2, 2, 2, 2]);
    expect((steps.at(-1)!.metadata as { final: boolean }).final).toBe(true);
  });

  it("pages each step exactly once when two sweeps race", async () => {
    const smsA = recordingSms();
    const smsB = recordingSms();
    // Two instances: separate sweep objects and providers over the same Redis and store.
    const a = createSosEscalationSweep(depsWith(), { sms: smsA });
    const b = createSosEscalationSweep(depsWith(), { sms: smsB });
    for (let i = 0; i < 10; i++) await raiseAt(`a-race-${i}`, T0);

    clock = T0 + 60_000;
    await Promise.all([a.sweepOnce(), b.sweepOnce(), a.sweepOnce(), b.sweepOnce()]);

    const all = [...smsA.sent, ...smsB.sent];
    expect(all).toHaveLength(10 * TIER1.length);
    expect(audit.entries.filter((e) => e.action === "sos.escalated")).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect((await sos.get(`a-race-${i}`))!.escalationStep).toBe(1);
    }
  });

  it("does not page the next tier early off a stale schedule entry", async () => {
    const sms = recordingSms();
    const sweep = createSosEscalationSweep(depsWith(), { sms });
    await raiseAt("a-stale", T0);
    clock = T0 + 60_000;
    await sweep.sweepOnce();
    expect(sms.sent).toHaveLength(2);

    // A reconcile on another instance read the row before step 1 was recorded and re-added the
    // entry at step 1's deadline. The row says tier 2 is not due for two minutes.
    await redis.client.zadd(keys.sosEscalationQueue(), T0 + 60_000, "a-stale");
    clock = T0 + 61_000;
    await sweep.sweepOnce();

    expect(sms.sent).toHaveLength(2);
    expect(Number(await scheduled("a-stale"))).toBe(T0 + 60_000 + 120_000);
  });

  it("is picked up by a new sweep instance after a restart", async () => {
    const before = recordingSms();
    const first = createSosEscalationSweep(depsWith(), { sms: before });
    await raiseAt("a-restart", T0);
    clock = T0 + 60_000;
    await first.sweepOnce();
    expect(before.sent).toHaveLength(2);
    first.stop();

    // "Restart": nothing in process memory survives; a fresh instance has only Redis + the row.
    const after = recordingSms();
    const second = createSosEscalationSweep(depsWith(), { sms: after });
    clock = T0 + 60_000 + 120_000;
    await second.sweepOnce();
    expect(after.sent.map((s) => s.phone)).toEqual(TIER2);
  });

  it("rebuilds a lost schedule from the database on reconcile", async () => {
    const sms = recordingSms();
    await raiseAt("a-lost", T0);
    // Redis lost the entry (a crash between claim and re-arm, or a flushed instance).
    await redis.client.del(keys.sosEscalationQueue());

    const sweep = createSosEscalationSweep(depsWith(), { sms });
    clock = T0 + 60_000;
    await sweep.sweepOnce();
    expect(sms.sent).toHaveLength(0);

    await sweep.reconcile();
    expect(Number(await scheduled("a-lost"))).toBe(T0 + 60_000);
    await sweep.sweepOnce();
    expect(sms.sent).toHaveLength(2);

    // An acknowledged alert is NOT re-armed by reconcile.
    await raiseAt("a-lost-acked", T0);
    await sos.acknowledge("a-lost-acked", "op-1", T0 + 1);
    await redis.client.del(keys.sosEscalationQueue());
    await sweep.reconcile();
    expect(await scheduled("a-lost-acked")).toBeNull();
  });

  it("records partial delivery honestly when a carrier refuses a number", async () => {
    const sms = recordingSms([TIER1[0]!]);
    const sweep = createSosEscalationSweep(depsWith(), { sms });
    await raiseAt("a-partial", T0);
    clock = T0 + 60_000;
    await sweep.sweepOnce();

    expect(sms.sent.map((s) => s.phone)).toEqual([TIER1[1]]);
    const row = audit.entries.find((e) => e.action === "sos.escalated")!;
    expect(row.metadata).toMatchObject({ recipients: 2, delivered: 1 });
  });

  it("sends nobody's phone, address, position or note", async () => {
    const sms = recordingSms();
    const sweep = createSosEscalationSweep(depsWith(), { sms });
    const note = `He is at 14 MG Road, call me on ${REQUESTER_PHONE}`;
    await raiseAt("a-pii", T0, {
      taskId: "task_PiiCheck-1",
      note,
      at: { lat: 12.97161, lng: 77.59463 },
    });
    clock = T0 + 3 * 60_000;
    // (Not on schedule: the entry is due at +60 s, and is simply late here.)
    await sweep.sweepOnce();

    expect(sms.sent.length).toBeGreaterThan(0);
    for (const { body } of sms.sent) {
      expect(body).not.toContain(REQUESTER_PHONE);
      expect(body).not.toContain(HELPER_PHONE);
      expect(body).not.toMatch(/\+\d{7,}/);
      expect(body).not.toContain("MG Road");
      expect(body).not.toContain("12.97");
      expect(body).not.toContain("77.59");
      // What it SHOULD say: kind, task, how long, and where to go.
      expect(body).toContain("medical");
      expect(body).toContain("task_PiiCheck-1");
      expect(body).toContain("3 min");
      expect(body).toContain("https://console.needy.test/admin/sos");
    }
  });

  it("still pages and audits the tier when the re-arm fails after the step is recorded", async () => {
    const sms = recordingSms();
    const logger = recordingLogger();
    await raiseAt("a-rearm", T0);
    // The step's compare-and-set commits to the row, then the re-arm ZADD fails. That throw used
    // to escape before the SMS and the audit row: the row said "tier 1 paged" and nobody was.
    const flaky = { ...redis, client: zaddFailsOnce(redis.client) } as RedisClients;
    const sweep = createSosEscalationSweep(depsWith({ redis: flaky, logger }), { sms });
    clock = T0 + 60_000;
    await sweep.sweepOnce();

    expect(sms.sent.map((s) => s.phone).sort()).toEqual([...TIER1].sort());
    const rows = audit.entries.filter((e) => e.action === "sos.escalated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ step: 1, tier: 1, delivered: 2 });
    expect(logger.errors.some((e) => e.msg.includes("could not be re-armed"))).toBe(true);
    expect(logger.errors.some((e) => e.msg === "sos escalation failed")).toBe(false);

    // The schedule entry was lost; reconcile puts it back from the row, and tier 2 follows on
    // time rather than being skipped.
    expect(await scheduled("a-rearm")).toBeNull();
    await sweep.reconcile();
    expect(Number(await scheduled("a-rearm"))).toBe(T0 + 60_000 + 120_000);
    clock = T0 + 60_000 + 120_000;
    await sweep.sweepOnce();
    expect(sms.sent.slice(2).map((s) => s.phone)).toEqual(TIER2);
  });

  it("re-arms a lost raised alarm behind more than a page of acknowledged ones", async () => {
    // 501 acknowledged-but-unresolved alerts, all older than the one raised alarm. Reconcile
    // used to read the console's open queue (raised AND acknowledged, oldest first, 500 rows),
    // so the newest raised alarm never made the cut.
    for (let i = 0; i < 501; i++) {
      await sos.create(
        makeSosAlert({
          id: `a-acked-backlog-${i}`,
          taskId: "task-backlog",
          raisedBy: "req-esc",
          kind: "other",
          status: "acknowledged",
          createdAt: T0 - 10_000 + i,
          updatedAt: T0,
        }),
      );
    }
    await raiseAt("a-behind-backlog", T0);
    await redis.client.del(keys.sosEscalationQueue());

    const sweep = createSosEscalationSweep(depsWith(), { sms: recordingSms() });
    await sweep.reconcile();
    expect(Number(await scheduled("a-behind-backlog"))).toBe(T0 + 60_000);
    expect(await redis.client.zcard(keys.sosEscalationQueue())).toBe(1);
  });

  it("pages through every raised alert on reconcile, not only the first page", async () => {
    for (let i = 0; i < 5; i++) await raiseAt(`a-paged-${i}`, T0 + i);
    // Same created_at for two of them, so the keyset tiebreak on id is exercised too.
    await raiseAt("a-paged-tie", T0 + 2);
    await redis.client.del(keys.sosEscalationQueue());

    const sweep = createSosEscalationSweep(depsWith(), {
      sms: recordingSms(),
      reconcilePageSize: 2,
    });
    await sweep.reconcile();
    expect(await redis.client.zcard(keys.sosEscalationQueue())).toBe(6);
    expect(Number(await scheduled("a-paged-tie"))).toBe(T0 + 2 + 60_000);
  });

  it("does not page about an alarm whose page fell due long ago, and logs it instead", async () => {
    const sms = recordingSms();
    const logger = recordingLogger();
    const sweep = createSosEscalationSweep(depsWith({ logger }), { sms });
    // Left `raised` from before escalation existed, or raised just before a long outage: its
    // first page fell due more than the cap ago.
    await raiseAt("a-too-late", T0);
    clock = T0 + 60_000 + 3600_000 + 1;
    await sweep.sweepOnce();

    expect(sms.sent).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
    expect((await sos.get("a-too-late"))!.escalationStep).toBe(0);
    expect(logger.errors.some((e) => e.meta?.alertId === "a-too-late")).toBe(true);
    // Not put back by reconcile either, but named in its error line every pass.
    await sweep.reconcile();
    expect(await scheduled("a-too-late")).toBeNull();
    const line = logger.errors.find(
      (e) => e.msg.includes("too late to page on-call") && e.meta?.count,
    );
    expect(line?.meta).toMatchObject({ count: 1, alertIds: ["a-too-late"] });
  });

  it("still pages an alarm raised during a short outage", async () => {
    const sms = recordingSms();
    const sweep = createSosEscalationSweep(depsWith(), { sms });
    await raiseAt("a-outage", T0);
    // Twenty minutes late: the sweep was down for a deploy. Well inside the cap.
    clock = T0 + 60_000 + 20 * 60_000;
    await sweep.sweepOnce();
    expect(sms.sent.map((s) => s.phone).sort()).toEqual([...TIER1].sort());
  });

  it("does nothing in development when there is no on-call list (production refuses to boot)", async () => {
    const sms = recordingSms();
    const empty = { ...ESC_CONFIG, sos: { ...ESC_CONFIG.sos, oncallTiers: [] } } as Config;
    const sweep = createSosEscalationSweep(depsWith({ config: empty }), { sms });
    await raiseAt("a-nobody", T0);
    clock = T0 + 60_000;
    await sweep.sweepOnce();
    expect(sms.sent).toHaveLength(0);
    expect((await sos.get("a-nobody"))!.escalationStep).toBe(0);
  });
});

// ── the rules, without Redis ─────────────────────────────────────────────────

describe("SOS escalation rules", () => {
  it("parses ordered tiers and refuses anything that would silently never ring", () => {
    expect(parseOncallTiers("X", "")).toEqual([]);
    expect(parseOncallTiers("X", undefined)).toEqual([]);
    expect(parseOncallTiers("X", " +919000009101 | +919000009102 , +919000009201 ")).toEqual([
      ["+919000009101", "+919000009102"],
      ["+919000009201"],
    ]);
    expect(() => parseOncallTiers("X", "9000009101")).toThrow(/non-E\.164/);
    expect(() => parseOncallTiers("X", "+919000009101,,+919000009201")).toThrow(/tier 2 is empty/);
    // The bad number is not echoed into the boot log.
    expect(() => parseOncallTiers("X", "+91-900")).toThrow(/^(?!.*900).*$/);
  });

  it("refuses a production boot with no on-call numbers, and only warns in development", () => {
    const warnings: string[] = [];
    const log: Logger = { ...silentLogger, warn: (m) => void warnings.push(m) };
    const empty = { ...ESC_CONFIG.sos, oncallTiers: [] };

    expect(() =>
      assertSosEscalationReachable(empty, { isProduction: true, smsProvider: "twilio" }, log),
    ).toThrow(/SOS_ONCALL_PHONES/);

    assertSosEscalationReachable(empty, { isProduction: false, smsProvider: "twilio" }, log);
    expect(warnings.some((w) => w.includes("SOS_ONCALL_PHONES"))).toBe(true);

    expect(() =>
      assertSosEscalationReachable(
        ESC_CONFIG.sos,
        { isProduction: true, smsProvider: "twilio" },
        log,
      ),
    ).not.toThrow();
  });

  it("refuses a production console link that is plain http or points at localhost", () => {
    const withOrigin = (consoleOrigin: string) => ({ ...ESC_CONFIG.sos, consoleOrigin });
    const prod = { isProduction: true, smsProvider: "twilio" };
    // What webOrigin() falls back to with PUBLIC_WEB_ORIGIN and CORS_ORIGIN unset.
    expect(() =>
      assertSosEscalationReachable(withOrigin("http://localhost:3000"), prod, silentLogger),
    ).toThrow(/https/);
    expect(() =>
      assertSosEscalationReachable(withOrigin("http://app.needy.test"), prod, silentLogger),
    ).toThrow(/https/);
    for (const local of [
      "https://localhost:3000",
      "https://127.0.0.1",
      "https://[::1]:3000",
      "https://web.localhost",
      "https://0.0.0.0",
    ]) {
      expect(() => assertSosEscalationReachable(withOrigin(local), prod, silentLogger)).toThrow(
        /localhost/,
      );
    }
    expect(() =>
      assertSosEscalationReachable(withOrigin("https://app.needy.test"), prod, silentLogger),
    ).not.toThrow();
    // Development keeps the laptop default.
    expect(() =>
      assertSosEscalationReachable(
        withOrigin("http://localhost:3000"),
        { isProduction: false, smsProvider: "twilio" },
        silentLogger,
      ),
    ).not.toThrow();
  });

  it("measures lateness from when the page fell due, so a running ladder is never cut short", () => {
    const cfg = ESC_CONFIG.sos;
    expect(isEscalationTooLate(T0, T0 + 3600_000, cfg)).toBe(false);
    expect(isEscalationTooLate(T0, T0 + 3600_000 + 1, cfg)).toBe(true);
    // A ladder whose steps are longer than the cap still runs: each page is on time.
    const slow = { ...cfg, escalationStepsSeconds: [7200] };
    const alert = makeSosAlert({
      id: "x",
      taskId: "t",
      raisedBy: "u",
      kind: "panic",
      createdAt: T0,
      escalationStep: 1,
      escalationTier: 1,
      escalatedAt: T0 + 60_000,
    });
    const due = nextEscalationDue(alert, slow)!;
    expect(isEscalationTooLate(due, due + 1_000, slow)).toBe(false);
  });

  it("hides the escalation state from the participant view and nothing else", () => {
    const alert = makeSosAlert({
      id: "x",
      taskId: "t",
      raisedBy: "u",
      kind: "panic",
      createdAt: T0,
      acknowledgedBy: "op",
      escalationStep: 3,
      escalationTier: 2,
      escalatedAt: T0 + 1,
    });
    const view = participantSosView(alert);
    expect(view).toEqual({ ...alert, escalationStep: 0, escalationTier: 0, escalatedAt: null });
    // The operator's copy is untouched.
    expect(alert.escalationStep).toBe(3);
  });

  it("says out loud that the console provider delivers nothing", () => {
    const warnings: string[] = [];
    const log: Logger = { ...silentLogger, warn: (m) => void warnings.push(m) };
    assertSosEscalationReachable(
      ESC_CONFIG.sos,
      { isProduction: false, smsProvider: "console" },
      log,
    );
    expect(warnings.some((w) => w.includes("CONSOLE SMS STUB"))).toBe(true);
  });

  it("derives the next deadline from durable state", () => {
    const cfg = ESC_CONFIG.sos;
    const base = makeSosAlert({
      id: "x",
      taskId: "t",
      raisedBy: "u",
      kind: "panic",
      createdAt: T0,
    });
    expect(nextEscalationDue(base, cfg)).toBe(T0 + 60_000);
    expect(nextEscalationDue({ ...base, escalationStep: 1, escalatedAt: T0 + 60_000 }, cfg)).toBe(
      T0 + 180_000,
    );
    expect(nextEscalationDue({ ...base, escalationStep: 2, escalatedAt: T0 }, cfg)).toBe(
      T0 + 300_000,
    );
    expect(nextEscalationDue({ ...base, status: "acknowledged" }, cfg)).toBeNull();
    expect(nextEscalationDue({ ...base, escalationStep: 2 + TOP_TIER_REPEATS }, cfg)).toBeNull();
  });

  it("refuses to print a task id that is not one of ours", () => {
    const body = escalationMessage(
      { kind: "panic", taskId: "x +919000009001 y", tier: 1, unansweredMs: 61_000 },
      "https://c.test",
    );
    expect(body).not.toContain("+919000009001");
    expect(body).toContain("(see console)");
  });
});

// ── the compare-and-set, against real Postgres ───────────────────────────────

describe("SOS escalation against Postgres", () => {
  const harness = new PgHarness();
  let pool: pg.Pool;
  let redisRaw: Redis;
  let redis: RedisClients;
  let io: IOServer;
  const PG_PREFIX = `${KEY_PREFIX}pg:`;

  beforeAll(async () => {
    await harness.connect();
    pool = await harness.freshDb("sosesc");
    await pool.query(
      `INSERT INTO users (id, phone, display_name, role, kyc_status, created_at, updated_at, onboarding_status)
       VALUES ('esc-req','+919000009003','X','both','verified',1,1,'approved')`,
    );
    await pool.query(
      `INSERT INTO tasks (id, requester_id, category, state, origin_lat, origin_lng,
                          title, description, price, created_at, updated_at)
       VALUES ('esc-task','esc-req','errand','in-progress',12.9,77.6,'Medicine','t',100,1,1)`,
    );
    redisRaw = new Redis(config.redisUrl, { db: REDIS_DB, keyPrefix: PG_PREFIX });
    const client = redisRaw as unknown as RedisClient;
    redis = { client, pub: client, sub: client } as unknown as RedisClients;
    io = new IOServer();
  });

  afterAll(async () => {
    const found = await redisRaw.keys(`${PG_PREFIX}*`);
    if (found.length > 0) await redisRaw.del(...found.map((k) => k.slice(PG_PREFIX.length)));
    redisRaw.disconnect();
    await harness.dropAll();
  });

  it("round-trips the escalation columns and lets exactly one writer take a step", async () => {
    const repo = createPgSosRepo(pool);
    await repo.create(
      makeSosAlert({ id: "pg-a", taskId: "esc-task", raisedBy: "esc-req", kind: "panic" }),
    );
    expect(await repo.get("pg-a")).toMatchObject({ escalationStep: 0, escalationTier: 0 });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.recordEscalation("pg-a", 0, 1, T0)),
    );
    expect(results.filter((r) => r != null)).toHaveLength(1);
    expect(await repo.get("pg-a")).toMatchObject({
      escalationStep: 1,
      escalationTier: 1,
      escalatedAt: T0,
    });

    // Acknowledged → refused, whatever step the caller thinks it is on.
    await repo.acknowledge("pg-a", "esc-req", T0 + 1);
    expect(await repo.recordEscalation("pg-a", 1, 2, T0 + 2)).toBeNull();
  });

  it("lists only raised alerts still owed a page, keyset-paged oldest first", async () => {
    const repo = createPgSosRepo(pool);
    const at = 1_000;
    const mk = (id: string, createdAt: number, extra: Partial<SosAlert> = {}) =>
      repo.create(
        makeSosAlert({
          id,
          taskId: "esc-task",
          raisedBy: "esc-req",
          kind: "panic",
          createdAt,
          updatedAt: createdAt,
          ...extra,
        }),
      );
    await mk("ls-acked", at, { status: "acknowledged" });
    await mk("ls-1", at + 1);
    await mk("ls-2b", at + 2);
    await mk("ls-2a", at + 2);
    await mk("ls-exhausted", at + 3, { escalationStep: 5, escalationTier: 2, escalatedAt: at });
    await mk("ls-4", at + 4, { escalationStep: 1, escalationTier: 1, escalatedAt: at });

    const seen: string[] = [];
    let after: { createdAt: number; id: string } | null = null;
    for (;;) {
      const page = await repo.listEscalatable({ belowStep: 5, after, limit: 2 });
      seen.push(...page.map((a) => a.id));
      if (page.length < 2) break;
      after = { createdAt: page.at(-1)!.createdAt, id: page.at(-1)!.id };
    }
    // Other cases in this file share the database; keep to this case's rows.
    expect(seen.filter((id) => id.startsWith("ls-"))).toEqual(["ls-1", "ls-2a", "ls-2b", "ls-4"]);

    // Close them, so the sweep cases below that share this database never see them.
    for (const id of ["ls-acked", "ls-1", "ls-2b", "ls-2a", "ls-exhausted", "ls-4"]) {
      await repo.resolve(id, "esc-req", "test fixture", at + 10);
    }
  });

  it("pages once when two sweeps race over the real store", async () => {
    const repo = createPgSosRepo(pool);
    await repo.create(
      makeSosAlert({
        id: "pg-race",
        taskId: "esc-task",
        raisedBy: "esc-req",
        kind: "unsafe",
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    const audit = recordingAudit();
    const deps = (): Deps => ({
      io,
      redis,
      logger: silentLogger,
      config: ESC_CONFIG,
      tasks: createInMemoryTaskRepo(),
      messages: createInMemoryMessageRepo(),
      helpers: createInMemoryHelperProfileRepo(),
      sos: repo,
      users: createInMemoryUserRepo(),
      services: createInMemoryServiceCatalog(),
      exceptions: createInMemoryExceptionRepo(),
      audit,
      abuse: createInMemoryAbuseRepo(),
      now: () => T0 + 60_000,
    });
    const smsA = recordingSms();
    const smsB = recordingSms();
    const a = createSosEscalationSweep(deps(), { sms: smsA });
    const b = createSosEscalationSweep(deps(), { sms: smsB });

    // Both instances rebuild the schedule from the row and then sweep at once — the reconcile
    // re-add racing a claim is exactly the case the row's compare-and-set exists for.
    await Promise.all([a.reconcile(), b.reconcile()]);
    await Promise.all([a.sweepOnce(), b.sweepOnce(), a.reconcile(), b.sweepOnce()]);

    expect(smsA.sent.length + smsB.sent.length).toBe(TIER1.length);
    expect(audit.entries).toHaveLength(1);
    expect(await repo.get("pg-race")).toMatchObject({ escalationStep: 1, escalationTier: 1 });
  });
});

// ── wiring: raise arms it, acknowledge / resolve / cancel disarm it ──────────

type SosSocketClient = ClientSocket<SosServerEvents, SosClientEvents>;

describe("SOS escalation wiring", () => {
  const TASK_ID = "task-esc-wiring";
  const REQUESTER_ID = "req-esc-wiring";
  const HELPER_ID = "helper-esc-wiring";
  const ADMIN_ID = "admin-esc-wiring";
  const WIRING_PREFIX = `${KEY_PREFIX}wiring:`;
  let clock = T0;

  let httpServer: HttpServer;
  let io: IOServer;
  let redisRaw: Redis;
  let redis: RedisClients;
  let app: express.Express;
  let requester: SosSocketClient;
  let operator: SosSocketClient;
  let port: number;
  const wiringSos = createInMemorySosRepo();

  const token = (id: string, role: Role) =>
    signAccessToken({ sub: id, role, displayName: id, kyc: "verified" });

  function raise(): Promise<{ ok: boolean; alert?: SosAlert }> {
    return new Promise((resolve) =>
      requester.emit("raise", { taskId: TASK_ID, kind: "panic" }, resolve as never),
    );
  }
  const scheduled = (id: string) => redis.client.zscore(keys.sosEscalationQueue(), id);

  beforeAll(async () => {
    redisRaw = new Redis(config.redisUrl, { db: REDIS_DB, keyPrefix: WIRING_PREFIX });
    const client = redisRaw as unknown as RedisClient;
    redis = { client, pub: client, sub: client } as unknown as RedisClients;

    const users = createInMemoryUserRepo();
    await users.create(
      makeUser({ id: REQUESTER_ID, phone: REQUESTER_PHONE, role: "requester", displayName: "A" }),
    );
    await users.create(
      makeUser({ id: HELPER_ID, phone: HELPER_PHONE, role: "helper", displayName: "B" }),
    );
    await users.create(
      makeUser({ id: ADMIN_ID, phone: "+919000009004", role: "admin", displayName: "Ops" }),
    );
    const tasks = createInMemoryTaskRepo();
    await tasks.create(
      makeTask({
        id: TASK_ID,
        requesterId: REQUESTER_ID,
        helperId: HELPER_ID,
        category: "errand",
        state: "in-progress",
        origin: { lat: 12.97, lng: 77.59 },
        title: "Pick up medicine",
        createdAt: T0,
        updatedAt: T0,
      }),
    );

    httpServer = createServer();
    io = new IOServer(httpServer);
    const deps: Deps = {
      io,
      redis,
      logger: silentLogger,
      config: ESC_CONFIG,
      tasks,
      messages: createInMemoryMessageRepo(),
      helpers: createInMemoryHelperProfileRepo(),
      sos: wiringSos,
      users,
      services: createInMemoryServiceCatalog(),
      exceptions: createInMemoryExceptionRepo(),
      audit: recordingAudit(),
      abuse: createInMemoryAbuseRepo(),
      now: () => clock,
    };
    io.of(NS.sos).use(authMiddleware);
    registerSos(deps);
    app = express();
    app.use(express.json());
    app.use(createSosAdminRouter(deps));

    await new Promise<void>((r) => httpServer.listen(0, r));
    port = (httpServer.address() as AddressInfo).port;
    requester = ioClient(`http://localhost:${port}${NS.sos}`, {
      transports: ["websocket"],
      auth: { token: token(REQUESTER_ID, "requester") },
      forceNew: true,
    });
    await new Promise<void>((resolve, reject) => {
      requester.on("connect", () => resolve());
      requester.on("connect_error", reject);
    });
  });

  afterAll(async () => {
    requester?.disconnect();
    operator?.disconnect();
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    const found = await redisRaw.keys(`${WIRING_PREFIX}*`);
    if (found.length > 0) await redisRaw.del(...found.map((k) => k.slice(WIRING_PREFIX.length)));
    redisRaw.disconnect();
  });

  // The raise token bucket is real; give each case a full one.
  beforeEach(() => {
    clock += 60_000;
  });

  it("arms escalation at raise + threshold", async () => {
    const res = await raise();
    expect(res.ok).toBe(true);
    expect(Number(await scheduled(res.alert!.id))).toBe(clock + 60_000);
  });

  it("disarms it when an operator acknowledges", async () => {
    const { alert } = await raise();
    const res = await request(app)
      .post(`/admin/sos/${alert!.id}/acknowledge`)
      .set("Authorization", `Bearer ${token(ADMIN_ID, "admin")}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.alert.escalationStep).toBe(0);
    expect(await scheduled(alert!.id)).toBeNull();
  });

  it("disarms it when an operator resolves straight from raised", async () => {
    const { alert } = await raise();
    const res = await request(app)
      .post(`/admin/sos/${alert!.id}/resolve`)
      .set("Authorization", `Bearer ${token(ADMIN_ID, "admin")}`)
      .send({ note: "called, fine" });
    expect(res.status).toBe(200);
    expect(await scheduled(alert!.id)).toBeNull();
  });

  it("tells operators how far an alarm was escalated, and the participants nothing", async () => {
    operator = ioClient(`http://localhost:${port}${NS.sos}`, {
      transports: ["websocket"],
      auth: { token: token(ADMIN_ID, "admin") },
      forceNew: true,
    });
    await new Promise<void>((resolve, reject) => {
      operator.on("connect", () => resolve());
      operator.on("connect_error", reject);
    });
    const watched = await new Promise<{ ok: boolean }>((resolve) =>
      operator.emit("watch", resolve as never),
    );
    expect(watched.ok).toBe(true);

    const { alert } = await raise();
    // The sweep paged tier 1 while nobody was at the console.
    await wiringSos.recordEscalation(alert!.id, 0, 1, clock + 60_000);

    const updateFor = (sock: SosSocketClient) =>
      new Promise<SosAlert>((resolve) => {
        const on = (a: SosAlert) => {
          if (a.id !== alert!.id) return;
          sock.off("sos-updated", on);
          resolve(a);
        };
        sock.on("sos-updated", on);
      });
    const seenByRequester = updateFor(requester);
    const seenByOperator = updateFor(operator);

    const res = await request(app)
      .post(`/admin/sos/${alert!.id}/acknowledge`)
      .set("Authorization", `Bearer ${token(ADMIN_ID, "admin")}`)
      .send({});
    expect(res.status).toBe(200);
    // The admin API is staff-facing and carries the truth.
    expect(res.body.alert).toMatchObject({ escalationStep: 1, escalationTier: 1 });

    expect(await seenByOperator).toMatchObject({
      status: "acknowledged",
      escalationStep: 1,
      escalationTier: 1,
      escalatedAt: clock + 60_000,
    });
    // The raiser learns a person has it — and not who else on staff was woken up.
    expect(await seenByRequester).toMatchObject({
      status: "acknowledged",
      escalationStep: 0,
      escalationTier: 0,
      escalatedAt: null,
    });
  });

  it("disarms it when the raiser cancels", async () => {
    const { alert } = await raise();
    const cancelled = await new Promise<{ ok: boolean }>((resolve) =>
      requester.emit("cancel", { alertId: alert!.id }, resolve as never),
    );
    expect(cancelled.ok).toBe(true);
    expect(await scheduled(alert!.id)).toBeNull();
  });
});
