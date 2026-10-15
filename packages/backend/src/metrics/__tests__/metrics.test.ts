import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSosAlert, NS } from "@needy/shared";
import type { Logger } from "../../logger.js";
import { createInMemorySosRepo } from "../../domain/sosStore.js";
import type { SosRepository } from "../../domain/sosStore.js";
import { requestObserver } from "../../http/requestObserver.js";
import { createAppMetrics, readBackupTimestamp, type AppMetrics } from "../appMetrics.js";
import { registerScrapeCollectors, type ScrapeSources } from "../collectors.js";
import { MetricsRegistry } from "../registry.js";
import { bearerMatches, createMetricsRouter } from "../router.js";

/**
 * GET /metrics: what it refuses, what it exposes, and what it must never expose.
 *
 * The app below is assembled the way index.ts assembles it — observer first, collectors, then
 * the router — out of in-memory sources, so the assertions are about the real wiring rather
 * than about the registry in isolation.
 */

const TOKEN = "metrics-test-token-0123456789abcdef0123";
const NOW = 1_800_000_000_000;

/** Ids and a phone number that exist in the data behind the scrape, and so are exactly what
 *  a careless label would leak. */
const RAISER_ID = "user-raiser-7f3a9c";
const TASK_ID = "task-secret-41b2";
const ALERT_ID = "alert-secret-9d0e";
const PHONE = "+919876543210";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

interface LogLine {
  level: string;
  msg: string;
  meta?: Record<string, unknown>;
}

function recordingLogger(): Logger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: string) =>
    (msg: string, meta?: Record<string, unknown>): void =>
      void lines.push({ level, msg, meta });
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

let clock = 0;
let m: AppMetrics;
let sos: SosRepository;
let log: ReturnType<typeof recordingLogger>;

function build(overrides: Partial<ScrapeSources> = {}, token = TOKEN): Express {
  const app = express();
  app.use(requestObserver({ metrics: m, logger: log, clockMs: () => clock }));
  registerScrapeCollectors(m, {
    sockets: () => ({ [NS.sos]: 2, [NS.matching]: 5 }),
    sos,
    uploads: { inUse: () => 3, max: 16 },
    probes: { redis: async () => "PONG", postgres: async () => ({ rows: [] }) },
    backupStatusFile: "/status/last-success",
    readFile: async () => "1799990000\n",
    now: () => NOW,
    ...overrides,
  });
  app.use(createMetricsRouter({ token, metrics: m, logger: log }));
  // A route that takes "30 ms" on the injected clock, carrying an id in its path.
  app.get("/tasks/:id", (_req, res) => {
    clock += 30;
    res.json({ ok: true });
  });
  app.get("/boom", (_req, res) => {
    res.status(500).json({ error: "internal-error" });
  });
  return app;
}

beforeEach(async () => {
  clock = 0;
  m = createAppMetrics();
  log = recordingLogger();
  sos = createInMemorySosRepo();
  await sos.create(
    makeSosAlert({
      id: ALERT_ID,
      taskId: TASK_ID,
      raisedBy: RAISER_ID,
      kind: "unsafe",
      note: `call me on ${PHONE}`,
      createdAt: NOW - 240_000,
      updatedAt: NOW - 240_000,
    }),
  );
  await sos.create(
    makeSosAlert({
      id: "alert-2",
      taskId: "task-2",
      raisedBy: "user-2",
      kind: "medical",
      status: "acknowledged",
      createdAt: NOW - 900_000,
      updatedAt: NOW - 800_000,
    }),
  );
});

const scrape = (app: Express) =>
  request(app).get("/metrics").set("Authorization", `Bearer ${TOKEN}`);

describe("GET /metrics access", () => {
  it("is not mounted at all when METRICS_TOKEN is unset", async () => {
    const app = build({}, "");
    const res = await request(app).get("/metrics").set("Authorization", "Bearer ");
    expect(res.status).toBe(404);
  });

  it("refuses a request with no token, a wrong token, or the token anywhere but the header", async () => {
    const app = build();
    expect((await request(app).get("/metrics")).status).toBe(401);
    expect(
      (await request(app).get("/metrics").set("Authorization", "Bearer wrong-token")).status,
    ).toBe(401);
    // Prefix and suffix of the real token, and the bare token without the scheme.
    expect(
      (
        await request(app)
          .get("/metrics")
          .set("Authorization", `Bearer ${TOKEN.slice(0, -1)}`)
      ).status,
    ).toBe(401);
    expect(
      (await request(app).get("/metrics").set("Authorization", `Bearer ${TOKEN}x`)).status,
    ).toBe(401);
    expect((await request(app).get("/metrics").set("Authorization", TOKEN)).status).toBe(401);
    // A query parameter would land in access logs; it is never accepted.
    expect((await request(app).get(`/metrics?token=${TOKEN}`)).status).toBe(401);
    const refused = await request(app).get("/metrics");
    expect(refused.headers["www-authenticate"]).toMatch(/^Bearer/);
    expect(refused.text).not.toContain("needy_");
  });

  it("bearerMatches compares the whole token", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN} `, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    // An empty configured token never matches anything, including an empty bearer.
    expect(bearerMatches("Bearer ", "")).toBe(false);
  });

  it("is refused on the public API host by Caddy, ahead of the reverse proxy", () => {
    const caddy = readFileSync(`${repoRoot}/Caddyfile`, "utf8");
    const api = caddy.slice(caddy.indexOf("api.{$DOMAIN}"));
    expect(api).toMatch(/@metrics path \/metrics \/metrics\/\*/);
    expect(api).toMatch(/respond @metrics 404/);
  });
});

describe("GET /metrics content", () => {
  it("exposes the expected metric families in Prometheus text format", async () => {
    const res = await scrape(build());
    expect(res.status).toBe(200);
    // Express re-serialises the parameters in its own order; Prometheus reads either.
    expect(res.headers["content-type"]).toMatch(/^text\/plain;/);
    expect(res.headers["content-type"]).toContain("version=0.0.4");
    expect(res.headers["cache-control"]).toBe("no-store");
    for (const name of [
      "process_uptime_seconds",
      "process_resident_memory_bytes",
      "nodejs_heap_used_bytes",
      "needy_http_requests_total",
      "needy_http_request_duration_seconds",
      "needy_socket_connections",
      "needy_sweep_runs_total",
      "needy_sweep_failures_total",
      "needy_sos_open_alerts",
      "needy_sos_oldest_unacknowledged_age_seconds",
      "needy_upload_slots_in_use",
      "needy_upload_slots_max",
      "needy_dependency_up",
      "needy_backup_last_success_timestamp_seconds",
    ]) {
      expect(res.text).toContain(`# TYPE ${name} `);
    }
    expect(res.text).toContain(`needy_socket_connections{namespace="/sos"} 2`);
    expect(res.text).toContain(`needy_sos_open_alerts{status="raised"} 1`);
    expect(res.text).toContain(`needy_sos_open_alerts{status="acknowledged"} 1`);
    // The oldest RAISED alert, not the older acknowledged one.
    expect(res.text).toContain("needy_sos_oldest_unacknowledged_age_seconds 240");
    expect(res.text).toContain("needy_upload_slots_in_use 3");
    expect(res.text).toContain(`needy_dependency_up{dependency="redis"} 1`);
    expect(res.text).toContain(`needy_dependency_up{dependency="postgres"} 1`);
    expect(res.text).toContain("needy_backup_last_success_timestamp_seconds 1799990000");
  });

  it("carries no user, task or alert id, phone number or raw path", async () => {
    const app = build();
    await request(app).get(`/tasks/${RAISER_ID}?phone=${encodeURIComponent(PHONE)}`);
    await request(app).get(`/no-such-path/${TASK_ID}`);
    const res = await scrape(app);
    expect(res.status).toBe(200);
    for (const secret of [RAISER_ID, TASK_ID, ALERT_ID, PHONE, "919876543210", "no-such-path"]) {
      expect(res.text).not.toContain(secret);
    }
    // The route is the template, and an unknown path is one series however many are tried.
    expect(res.text).toContain(`route="/tasks/:id"`);
    expect(res.text).toContain(`route="unmatched"`);
  });

  it("counts a request in the duration histogram, in the bucket its duration falls in", async () => {
    const app = build();
    const labels = { method: "GET", route: "/tasks/:id", status: "200" };
    expect(m.httpDuration.count(labels)).toBe(0);

    await request(app).get("/tasks/abc");
    await vi.waitFor(() => expect(m.httpDuration.count(labels)).toBe(1));
    await request(app).get("/tasks/def");
    await vi.waitFor(() => expect(m.httpDuration.count(labels)).toBe(2));
    expect(m.httpRequests.get(labels)).toBe(2);

    const text = (await scrape(app)).text;
    const series = `method="GET",route="/tasks/:id",status="200"`;
    // 30 ms each: not in the 25 ms bucket, both in the 50 ms one.
    expect(text).toContain(`needy_http_request_duration_seconds_bucket{${series},le="0.025"} 0`);
    expect(text).toContain(`needy_http_request_duration_seconds_bucket{${series},le="0.05"} 2`);
    expect(text).toContain(`needy_http_request_duration_seconds_bucket{${series},le="+Inf"} 2`);
    expect(text).toContain(`needy_http_request_duration_seconds_count{${series}} 2`);
    expect(text).toMatch(
      new RegExp(`needy_http_request_duration_seconds_sum\\{${series}\\} 0\\.06`),
    );
  });

  it("reports a dependency that does not answer as 0, not as a failed scrape", async () => {
    const app = build({ probes: { redis: () => Promise.reject(new Error("ECONNREFUSED")) } });
    const res = await scrape(app);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`needy_dependency_up{dependency="redis"} 0`);
    // In-memory mode: no database configured, so no postgres series at all.
    expect(res.text).not.toContain(`dependency="postgres"`);
  });

  it("drops the SOS numbers rather than serving stale ones when the query fails", async () => {
    let fail = false;
    const flaky: Pick<SosRepository, "openSummary"> = {
      openSummary: () => (fail ? Promise.reject(new Error("db down")) : sos.openSummary()),
    };
    const app = build({ sos: flaky });
    expect((await scrape(app)).text).toContain(`needy_sos_open_alerts{status="raised"} 1`);

    fail = true;
    const res = await scrape(app);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/^needy_sos_open_alerts\{/m);
    expect(res.text).not.toMatch(/^needy_sos_oldest_unacknowledged_age_seconds /m);
    expect(m.collectorFailures.get({ collector: "sos" })).toBe(1);
    expect(log.lines.some((l) => l.msg === "metrics collector failed")).toBe(true);
  });

  it("omits the backup timestamp when the status file is missing or malformed", async () => {
    const missing = await scrape(build({ readFile: () => Promise.reject(new Error("ENOENT")) }));
    expect(missing.text).not.toMatch(/^needy_backup_last_success_timestamp_seconds /m);
    expect(await readBackupTimestamp("x", async () => "not a number")).toBeNull();
    expect(await readBackupTimestamp("x", async () => "")).toBeNull();
    expect(await readBackupTimestamp("x", async () => " 1799990000 \n")).toBe(1799990000);
  });

  it("exposes every metric the alert rules in ops/alerts.yml depend on", async () => {
    // Sweeps and a request have run, so every series an alert reads exists.
    m.recordSweep("sos_escalation", true, NOW);
    m.recordSweep("matching_offer_expiry", false, NOW);
    const app = build();
    await request(app).get("/tasks/x");
    const text = (await scrape(app)).text;

    const rules = readFileSync(`${repoRoot}/ops/alerts.yml`, "utf8");
    const exprs = rules
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && !/^\s*(summary|description):/.test(l))
      .join("\n");
    const referenced = new Set(exprs.match(/\b(?:needy|process|nodejs)_[a-z0-9_]+/g) ?? []);
    expect(referenced.size).toBeGreaterThan(5);
    for (const name of referenced) {
      expect(text, `alerts.yml references ${name}`).toContain(`# TYPE ${name} `);
    }
  });
});

describe("request logging", () => {
  it("logs one line per request with a request id and the route template, never the path", async () => {
    const app = build();
    const res = await request(app).get(`/tasks/${RAISER_ID}?phone=${encodeURIComponent(PHONE)}`);
    const id = res.headers["x-request-id"];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await vi.waitFor(() => expect(log.lines.some((l) => l.msg === "http request")).toBe(true));
    const line = log.lines.find((l) => l.msg === "http request")!;
    expect(line.meta).toMatchObject({
      requestId: id,
      method: "GET",
      route: "/tasks/:id",
      status: 200,
    });
    expect(JSON.stringify(line)).not.toContain(RAISER_ID);
    expect(JSON.stringify(line)).not.toContain("919876543210");
  });

  it("echoes a well-formed incoming request id and replaces a malformed one", async () => {
    const app = build();
    const good = await request(app).get("/tasks/a").set("X-Request-Id", "client-req-12345678");
    expect(good.headers["x-request-id"]).toBe("client-req-12345678");
    // Legal in a header, but not an id: quotes and braces could break a log line downstream.
    const bad = await request(app).get("/tasks/a").set("X-Request-Id", 'x"},{"level":"error');
    expect(bad.headers["x-request-id"]).not.toContain('"');
    expect(bad.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs a failure at warn, and keeps healthy scrapes out of the log", async () => {
    const app = build();
    await request(app).get("/boom");
    await scrape(app);
    await vi.waitFor(() => expect(log.lines.some((l) => l.meta?.route === "/boom")).toBe(true));
    expect(log.lines.find((l) => l.meta?.route === "/boom")!.level).toBe("warn");
    expect(log.lines.some((l) => l.msg === "http request" && l.meta?.route === "/metrics")).toBe(
      false,
    );
  });
});

describe("MetricsRegistry", () => {
  it("rejects labels that were not declared, so ad-hoc labels cannot creep in", () => {
    const r = new MetricsRegistry();
    const c = r.counter("t_total", "t", ["route"]);
    expect(() => c.inc({ route: "/a", userId: "u1" })).toThrow(/takes labels/);
    expect(() => c.inc({})).toThrow(/takes labels/);
    expect(() => r.counter("t_total", "dup")).toThrow(/already registered/);
    expect(() => r.counter("bad-name", "x")).toThrow(/invalid metric name/);
    expect(() => c.inc({ route: "/a" }, -1)).toThrow(/only increase/);
  });

  it("escapes label values so one cannot forge another series", async () => {
    const r = new MetricsRegistry();
    r.gauge("g", "g", ["v"]).set({ v: 'a"} 1\nevil{v="b' }, 1);
    const { text } = await r.render();
    expect(text).toContain('g{v="a\\"} 1\\nevil{v=\\"b"} 1');
    expect(text.split("\n").filter((l) => l.startsWith("evil"))).toHaveLength(0);
  });
});
