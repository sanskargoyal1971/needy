import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  AVAILABILITY_TTL_MS,
  NS,
  type LatLng,
  type Presence,
  type PresenceClientEvents,
  type PresenceServerEvents,
  type SocketErrorPayload,
} from "@needy/shared";
import { config } from "../../config.js";
import { signAccessToken } from "../../auth/jwt.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { createInMemoryServiceCatalog } from "../../services/catalog.js";
import { createInMemoryExceptionRepo } from "../../domain/exceptions.js";
import { safetyDeps } from "../../test/safetyDeps.js";
import type { KycStatus, Role } from "../../auth/types.js";
import type { Deps } from "../../domain/deps.js";
import { keys } from "../../domain/keys.js";
import { freshHelperIds } from "../../domain/location-store.js";
import { readPresence } from "../../domain/presence-store.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import {
  createInMemoryHelperProfileRepo,
  createInMemoryMessageRepo,
  createInMemoryTaskRepo,
  type TaskRepository,
} from "../../domain/stores.js";
import type { RedisClient, RedisClients } from "../../redis.js";
import type { Logger } from "../../logger.js";
import { authMiddleware } from "../auth.js";
import { registerPresence } from "../presence.js";

/**
 * ── /presence: the idle-availability publish (audit A1), the socket refcount (B10) and
 *    subscription authorization (B9) ──────────────────────────────────────────
 *
 * THE BUG THIS SUITE EXISTS FOR. Matching finds helpers by GEOSEARCHing `geo:helpers`. The
 * only writer of that index was `/tracking`'s `location` event — which refuses anyone not
 * already assigned to a live task. So to become findable, a helper first had to be found. On
 * a system with no tasks in it, the index was empty, every search returned zero candidates,
 * and no task could ever be matched. `publish-availability` was declared in shared/events.ts
 * with a paragraph of documentation, had a zod schema, and had NO SERVER HANDLER; the type
 * existing is what made the gap look filled.
 *
 * WHY THE TASK REPOSITORY IS DELIBERATELY LEFT EMPTY. Every other socket suite seeds a task
 * before it can drive anything. That habit is precisely what hid this bug: a seeded task
 * means a helper who is already assigned, and an already-assigned helper can write the geo
 * index through `/tracking`. The `tasks` repo below is created and never written to, and the
 * first test asserts that emptiness out loud, so "a helper becomes findable from a cold
 * system" is what is actually under test rather than "a helper who is already working stays
 * findable".
 *
 * WHY `registerTracking` IS NOT REGISTERED HERE. It is the other writer of `geo:helpers`. If
 * it were mounted, a passing GEOSEARCH assertion would no longer be evidence about
 * `publish-availability` specifically. The only code that can put a member in that index in
 * this file is the handler under test.
 *
 * REAL REDIS, not ioredis-mock. `geoadd`/`geosearch` are not implemented by the mock at all,
 * and the whole claim being proved is about what does and does not land in a real GEO index.
 * Runs on db 15 under a per-run key prefix and deletes only its own keys in `afterAll`.
 */

type AppClient = ClientSocket<PresenceServerEvents, PresenceClientEvents>;
type OkAck = { ok: true } | { ok: false; error: string };

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const REDIS_DB = 15;
const KEY_PREFIX = `test:presence-avail:${process.pid}:${Date.now()}:`;

/** Bengaluru; NEAR is ~120 m away, so a small-radius search proves the coordinates were
 *  stored accurately rather than merely stored. */
const HERE: LatLng = { lat: 12.9716, lng: 77.5946 };
const NEAR: LatLng = { lat: 12.9725, lng: 77.5951 };
const FIXED_NOW = 1_700_000_000_000;

/** helper, kyc verified — the only account that should reach the index. */
const HELPER_OK = "avail-helper-ok";
/** helper, kyc pending — the case the audit's B11 filter was the *only* guard against. */
const HELPER_PENDING = "avail-helper-pending";
/** requester-only, kyc verified: verified is not the same as helper-capable. */
const REQUESTER = "avail-requester";
/** Two live sockets for one identity — the B10 refcount case. */
const TWO_TABS = "avail-two-tabs";
/** No relationship to anyone; used to prove a presence subscription is not a public feed. */
const STRANGER = "avail-stranger";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Frozen: the availability bucket has capacity 20 and this suite publishes a handful of
 *  times, so nothing here depends on refill. Every read in presence.ts goes through
 *  deps.now(), which is also what lets the freshness-score assertion be exact. */
const clock = FIXED_NOW;

function connect(
  port: number,
  userId: string,
  role: Role,
  kyc: KycStatus | undefined,
): Promise<AppClient> {
  const token = signAccessToken({
    sub: userId,
    role,
    displayName: userId,
    ...(kyc ? { kyc } : {}),
  });
  const socket: AppClient = ioClient(`http://localhost:${port}${NS.presence}`, {
    transports: ["websocket"],
    auth: { token },
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

const publish = (
  socket: AppClient,
  point: LatLng,
  available: boolean,
): Promise<OkAck> =>
  new Promise((resolve) =>
    socket.emit("publish-availability", { point, available }, resolve),
  );

/** Emit with a payload the typed client would refuse to produce — the point of a B7 check is
 *  that the SERVER does not trust the wire. */
const publishRaw = (socket: AppClient, payload: unknown): Promise<OkAck> =>
  new Promise((resolve) =>
    (socket as unknown as { emit: (e: string, p: unknown, a: unknown) => void }).emit(
      "publish-availability",
      payload,
      resolve,
    ),
  );

const emitRaw = (socket: AppClient, event: string, payload: unknown): void => {
  (socket as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
};

/** A refusal MUST arrive as an `error` event. A timeout here is not a flake — it means the
 *  server silently dropped the frame, which the audit called out by name: a helper waiting
 *  for work that will never come needs to be told why, not ignored. */
function nextError(socket: AppClient, ms = 3_000): Promise<SocketErrorPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for an error event")),
      ms,
    );
    socket.once("error", (payload) => {
      clearTimeout(timer);
      resolve(payload as SocketErrorPayload);
    });
  });
}

/** Poll for an eventually-consistent condition. The connect/disconnect bookkeeping in
 *  presence.ts is fire-and-forget async (a socket lifecycle callback cannot be awaited), so
 *  a fixed sleep would either be flaky or slow. */
async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
  ms = 3_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const settle = (ms = 150): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("/presence idle availability (audit A1 / B9 / B10)", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let client: RedisClient;
  /** Unprefixed connection, used only to enumerate and delete our prefixed keys. */
  let janitor: Redis;
  let port: number;

  /** Created, deliberately NEVER written to. See the header. */
  let tasks: TaskRepository;

  let helperOk: AppClient;
  let helperPending: AppClient;
  let requester: AppClient;
  let stranger: AppClient;

  /** Is this helper in the availability index, both halves of it? Matching intersects the GEO
   *  set with the freshness zset, so a member present in one and absent from the other is
   *  invisible to it — asserting only one half would pass while matching still found nobody. */
  const inIndex = async (userId: string): Promise<boolean> => {
    const geo = await client.zscore(keys.helperGeo(), userId);
    const fresh = await client.zscore(keys.helperGeoFresh(), userId);
    return geo != null && fresh != null;
  };

  beforeAll(async () => {
    client = new Redis(REDIS_URL, {
      db: REDIS_DB,
      keyPrefix: KEY_PREFIX,
    }) as unknown as RedisClient;
    janitor = new Redis(REDIS_URL, { db: REDIS_DB });
    // Fail loudly rather than degrading: a suite that silently skips its own subject is worse
    // than no suite, because it reports green.
    await client.ping();
    const redis = { client, pub: client, sub: client } as unknown as RedisClients;

    tasks = createInMemoryTaskRepo();

    httpServer = createServer();
    io = new IOServer(httpServer);
    const deps: Deps = {
      io,
      redis,
      logger: silentLogger,
      config,
      tasks,
      messages: createInMemoryMessageRepo(),
      helpers: createInMemoryHelperProfileRepo(),
      sos: createInMemorySosRepo(),
      users: createInMemoryUserRepo(),
      services: createInMemoryServiceCatalog(),
      exceptions: createInMemoryExceptionRepo(),
      ...safetyDeps(),
      now: () => clock,
    };
    io.of(NS.presence).use(authMiddleware);
    registerPresence(deps);

    await new Promise<void>((r) => httpServer.listen(0, r));
    port = (httpServer.address() as AddressInfo).port;

    helperOk = await connect(port, HELPER_OK, "helper", "verified");
    helperPending = await connect(port, HELPER_PENDING, "helper", "pending");
    requester = await connect(port, REQUESTER, "requester", "verified");
    stranger = await connect(port, STRANGER, "helper", "verified");
    // The connect handler writes presence asynchronously; the availability path reads it.
    await settle();
  });

  afterAll(async () => {
    for (const c of [helperOk, helperPending, requester, stranger]) c?.disconnect();
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    const found = await janitor.keys(`${KEY_PREFIX}*`);
    if (found.length > 0) await janitor.del(...found);
    (client as unknown as Redis).disconnect();
    janitor.disconnect();
  });

  // ── A1: the deadlock ──────────────────────────────────────────────────────

  it("makes a verified helper findable by GEOSEARCH with ZERO tasks in the system", async () => {
    // The precondition, asserted rather than assumed. If a future edit seeds a task in
    // `beforeAll` for convenience, this fails and says why — the whole claim of this test is
    // that nothing task-shaped is required to enter the availability index.
    expect(await tasks.activeForUser(HELPER_OK)).toHaveLength(0);
    expect(await tasks.activeForUser(REQUESTER)).toHaveLength(0);
    expect(await client.zcard(keys.helperGeo())).toBe(0);

    const ack = await publish(helperOk, HERE, true);
    expect(ack).toEqual({ ok: true });

    // Both halves of the index, because matching needs both.
    expect(await inIndex(HELPER_OK)).toBe(true);
    // The freshness score is the injected clock, which is what makes decay testable and what
    // matching compares against `now - AVAILABILITY_TTL_MS`.
    expect(Number(await client.zscore(keys.helperGeoFresh(), HELPER_OK))).toBe(clock);
    expect(await freshHelperIds(client, clock - AVAILABILITY_TTL_MS)).toContain(HELPER_OK);

    // THE ASSERTION THE AUDIT ASKED FOR: the exact query matching runs, from a point 120 m
    // away, against a system that has never had a task in it. Before the handler existed this
    // came back empty no matter how many helpers were online.
    const hits = (await client.geosearch(
      keys.helperGeo(),
      "FROMLONLAT",
      NEAR.lng,
      NEAR.lat,
      "BYRADIUS",
      1_000,
      "m",
      "ASC",
    )) as string[];
    expect(hits).toContain(HELPER_OK);

    // And the position stored is the one published, not a rounded or swapped pair. `geopos`
    // returns [lng, lat]; lat/lng transposition is the classic silent failure here, and it
    // would still satisfy a radius search around a nearby point in Bengaluru.
    const [pos] = (await client.geopos(keys.helperGeo(), HELPER_OK)) as [
      [string, string] | null,
    ];
    expect(pos).not.toBeNull();
    expect(Number(pos![0])).toBeCloseTo(HERE.lng, 4);
    expect(Number(pos![1])).toBeCloseTo(HERE.lat, 4);
  });

  it("de-lists immediately on available:false rather than waiting for the TTL", async () => {
    expect(await inIndex(HELPER_OK)).toBe(true);

    const ack = await publish(helperOk, HERE, false);
    expect(ack).toEqual({ ok: true });

    // Gone from BOTH halves. Leaving the stale entry to age out would keep sending a helper
    // work for up to AVAILABILITY_TTL_MS after they said they were finished — and the
    // requester would be waiting on someone who is not coming.
    expect(await client.zscore(keys.helperGeo(), HELPER_OK)).toBeNull();
    expect(await client.zscore(keys.helperGeoFresh(), HELPER_OK)).toBeNull();

    const hits = (await client.geosearch(
      keys.helperGeo(),
      "FROMLONLAT",
      NEAR.lng,
      NEAR.lat,
      "BYRADIUS",
      1_000,
      "m",
      "ASC",
    )) as string[];
    expect(hits).not.toContain(HELPER_OK);

    // Restore so later cases (the refcount one) have a live entry to reason about.
    expect(await publish(helperOk, HERE, true)).toEqual({ ok: true });
    expect(await inIndex(HELPER_OK)).toBe(true);
  });

  // ── Authorization on the publish itself ───────────────────────────────────

  it("refuses an unverified helper explicitly, and writes nothing", async () => {
    const err = nextError(helperPending);
    const ack = await publish(helperPending, HERE, true);

    // Refused out loud on both channels. "You are not verified yet" is the single most useful
    // thing a helper waiting for work can be told; a silent drop leaves them staring at an
    // empty screen concluding the app is broken.
    expect(ack).toEqual({ ok: false, error: "not-a-verified-helper" });
    const e = await err;
    expect(e.event).toBe("publish-availability");
    expect(e.code).toBe("NOT_AUTHORIZED");

    expect(await inIndex(HELPER_PENDING)).toBe(false);
    expect(await client.zscore(keys.helperGeo(), HELPER_PENDING)).toBeNull();
  });

  it("refuses a verified requester-only account (verified ≠ helper-capable)", async () => {
    const err = nextError(requester);
    const ack = await publish(requester, HERE, true);

    expect(ack).toEqual({ ok: false, error: "not-a-verified-helper" });
    expect((await err).code).toBe("NOT_AUTHORIZED");
    expect(await inIndex(REQUESTER)).toBe(false);
  });

  it("refuses a malformed payload before it can reach geoadd (audit B7)", async () => {
    // NaN passes `z.number()` and is what `parseFloat` on a bad sensor read produces. Reaching
    // `geoadd` with it is the failure the finite() constraint exists for.
    const err = nextError(helperOk);
    const ack = await publishRaw(helperOk, {
      point: { lat: Number.NaN, lng: 77.5946 },
      available: true,
    });
    expect(ack).toEqual({ ok: false, error: "invalid-payload" });
    expect((await err).code).toBe("INVALID_PAYLOAD");

    // Out of range, which is a plausible units bug (radians, or a swapped pair) rather than
    // a hostile client.
    const err2 = nextError(helperOk);
    const ack2 = await publishRaw(helperOk, {
      point: { lat: 12.9716, lng: 999 },
      available: true,
    });
    expect(ack2).toEqual({ ok: false, error: "invalid-payload" });
    expect((await err2).code).toBe("INVALID_PAYLOAD");

    // The previously-published good position is untouched — a rejected frame must not
    // clobber the last known good one.
    const [pos] = (await client.geopos(keys.helperGeo(), HELPER_OK)) as [
      [string, string] | null,
    ];
    expect(Number(pos![1])).toBeCloseTo(HERE.lat, 4);
  });

  // ── B10: the socket refcount ──────────────────────────────────────────────

  it("keeps a two-tab user online when one tab closes, and only flips at zero (audit B10)", async () => {
    const tabA = await connect(port, TWO_TABS, "helper", "verified");
    const tabB = await connect(port, TWO_TABS, "helper", "verified");

    await waitFor(
      async () => (await client.get(keys.socketCount(TWO_TABS))) === "2",
      "both tabs counted",
    );
    expect(await publish(tabA, HERE, true)).toEqual({ ok: true });
    expect(await inIndex(TWO_TABS)).toBe(true);

    // Close ONE. Before B10, `disconnect` wrote state:"offline" unconditionally, so this
    // marked a user who is sitting there with the app open as absent — and because matching
    // filters on `online-available`, a helper who was right there stopped being offered work.
    // The same thing happened on an ordinary reconnect, where socket.io's new socket connects
    // before the old one's disconnect lands.
    tabA.disconnect();
    await waitFor(
      async () => (await client.get(keys.socketCount(TWO_TABS))) === "1",
      "one tab remaining",
    );
    await settle();

    const still = (await readPresence(client, TWO_TABS)) as Presence;
    expect(still.state).toBe("online-available");
    // Still offerable, which is the consequence that actually matters.
    expect(await inIndex(TWO_TABS)).toBe(true);

    // Close the LAST one: now they are genuinely gone, so presence flips and — separately —
    // they leave the availability index rather than being left to the sweep. Everything in
    // that index is supposed to be someone who would actually answer.
    tabB.disconnect();
    await waitFor(async () => {
      const p = await readPresence(client, TWO_TABS);
      return p?.state === "offline";
    }, "last tab flips offline");
    await waitFor(async () => !(await inIndex(TWO_TABS)), "de-listed on final disconnect");

    // The counter key is deleted rather than left at 0, so a stray decrement can't drive it
    // negative and make every future disconnect look like "others are still here".
    expect(await client.get(keys.socketCount(TWO_TABS))).toBeNull();
  });

  // ── B9: a presence subscription is not a public feed ──────────────────────

  it("refuses a presence subscription to someone the caller shares no task with (audit B9)", async () => {
    // With no tasks in the repo, NOBODY shares a task with anybody — which is exactly the
    // cold-start state in which this used to hand out a live feed of any user's activity.
    const err = nextError(stranger);
    emitRaw(stranger, "subscribe", { helperId: HELPER_OK });

    const e = await err;
    expect(e.event).toBe("subscribe");
    expect(e.code).toBe("NOT_AUTHORIZED");

    // And no subscription was registered, so a later presence change cannot leak either. This
    // is the durable half of the check: refusing the event but recording the subscriber would
    // still deliver every subsequent update.
    const subs = await client.smembers(keys.presenceSubs(HELPER_OK));
    expect(subs).not.toContain(STRANGER);
  });

  it("allows subscribing to your own presence and answers with current state", async () => {
    const own = new Promise<Presence>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no presence-changed")), 3_000);
      stranger.once("presence-changed", (p) => {
        clearTimeout(timer);
        resolve(p);
      });
    });
    emitRaw(stranger, "subscribe", { helperId: STRANGER });

    const p = await own;
    expect(p.userId).toBe(STRANGER);
    expect(p.state).toBe("online-available");
  });

  it("stops delivering after unsubscribe", async () => {
    emitRaw(stranger, "unsubscribe", { helperId: STRANGER });
    await waitFor(async () => {
      const subs = await client.smembers(keys.presenceSubs(STRANGER));
      return !subs.includes(STRANGER);
    }, "subscription removed");
  });
});
