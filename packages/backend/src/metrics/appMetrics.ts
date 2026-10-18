import { readFile } from "node:fs/promises";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { MetricsRegistry, type Counter, type Gauge, type Histogram } from "./registry.js";

/**
 * ── What the backend reports to Prometheus ────────────────────────────────
 *
 * Every label below is a CLOSED set: an HTTP method, a route TEMPLATE (`/tasks/:id`, never
 * `/tasks/abc123`), a status code, a namespace name, a sweep name, an alert status, a
 * dependency name. No user, task or alert id, no phone number, no raw path, ever — the
 * scrape output is copied into a time-series store with its own retention and its own
 * readers, and nothing in it should need the PII controls the database has.
 */

/** Request-duration buckets, in seconds. Wide at the top on purpose: a KYC video upload is a
 *  legitimate 30-second request, and without a bucket up there it would read as "slow" forever. */
const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** The background loops whose health is worth alerting on. */
export type SweepName = "matching_offer_expiry" | "sos_escalation" | "booking_dispatch";

export interface AppMetrics {
  registry: MetricsRegistry;
  httpRequests: Counter;
  httpDuration: Histogram;
  sweepRuns: Counter;
  sweepFailures: Counter;
  sweepLastSuccess: Gauge;
  socketConnections: Gauge;
  sosOpen: Gauge;
  sosOldestRaisedAge: Gauge;
  uploadSlotsInUse: Gauge;
  uploadSlotsMax: Gauge;
  dependencyUp: Gauge;
  backupLastSuccess: Gauge;
  collectorFailures: Counter;
  /** Record one pass of a background sweep. `ok` false = it threw or any item in it failed. */
  recordSweep(sweep: SweepName, ok: boolean, nowMs: number): void;
}

export function createAppMetrics(): AppMetrics {
  const registry = new MetricsRegistry();

  // ── process ───────────────────────────────────────────────────────────────
  const uptime = registry.gauge("process_uptime_seconds", "Seconds since this process started.");
  const rss = registry.gauge("process_resident_memory_bytes", "Resident set size in bytes.");
  const heapUsed = registry.gauge("nodejs_heap_used_bytes", "V8 heap in use, in bytes.");
  const heapTotal = registry.gauge("nodejs_heap_total_bytes", "V8 heap allocated, in bytes.");
  const lagMean = registry.gauge(
    "nodejs_eventloop_lag_mean_seconds",
    "Mean event-loop delay since the previous scrape.",
  );
  const lagP99 = registry.gauge(
    "nodejs_eventloop_lag_p99_seconds",
    "99th percentile event-loop delay since the previous scrape.",
  );
  const lagMax = registry.gauge(
    "nodejs_eventloop_lag_max_seconds",
    "Worst event-loop delay since the previous scrape.",
  );

  // A libuv timer sampling at 20 ms. It does not hold the process open, so a short-lived test
  // or CLI process that imports this module still exits on its own.
  let loop: IntervalHistogram | null = null;
  try {
    loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
  } catch {
    loop = null;
  }

  registry.collect("process", () => {
    const mem = process.memoryUsage();
    uptime.set(undefined, process.uptime());
    rss.set(undefined, mem.rss);
    heapUsed.set(undefined, mem.heapUsed);
    heapTotal.set(undefined, mem.heapTotal);
    if (loop && loop.count > 0) {
      // perf_hooks reports nanoseconds.
      lagMean.set(undefined, loop.mean / 1e9);
      lagP99.set(undefined, loop.percentile(99) / 1e9);
      lagMax.set(undefined, loop.max / 1e9);
      // Per scrape interval, so one stall an hour ago does not sit in "max" for the life of
      // the process and make every later reading look alarming.
      loop.reset();
    }
  });

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const httpRequests = registry.counter(
    "needy_http_requests_total",
    "HTTP requests served, by method, route template and status.",
    ["method", "route", "status"],
  );
  const httpDuration = registry.histogram(
    "needy_http_request_duration_seconds",
    "HTTP request duration in seconds, by method, route template and status.",
    ["method", "route", "status"],
    HTTP_DURATION_BUCKETS,
  );

  // ── realtime and background work ─────────────────────────────────────────
  const socketConnections = registry.gauge(
    "needy_socket_connections",
    "Socket.io connections open on this process, per namespace.",
    ["namespace"],
  );
  const sweepRuns = registry.counter("needy_sweep_runs_total", "Passes of a background sweep.", [
    "sweep",
  ]);
  const sweepFailures = registry.counter(
    "needy_sweep_failures_total",
    "Sweep passes that threw, or in which any item failed.",
    ["sweep"],
  );
  const sweepLastSuccess = registry.gauge(
    "needy_sweep_last_success_timestamp_seconds",
    "Unix time of the last sweep pass that completed with no failure.",
    ["sweep"],
  );

  // ── safety ────────────────────────────────────────────────────────────────
  const sosOpen = registry.gauge(
    "needy_sos_open_alerts",
    "SOS alerts still owed an answer, by status (raised = nobody has acknowledged it).",
    ["status"],
  );
  const sosOldestRaisedAge = registry.gauge(
    "needy_sos_oldest_unacknowledged_age_seconds",
    "Age of the oldest SOS alert nobody has acknowledged; 0 when there is none.",
  );

  // ── capacity and dependencies ─────────────────────────────────────────────
  const uploadSlotsInUse = registry.gauge(
    "needy_upload_slots_in_use",
    "Concurrent document uploads in flight on this process.",
  );
  const uploadSlotsMax = registry.gauge(
    "needy_upload_slots_max",
    "Concurrent uploads this process accepts before answering 503.",
  );
  const dependencyUp = registry.gauge(
    "needy_dependency_up",
    "1 when a dependency answered its probe at scrape time, 0 when it did not.",
    ["dependency"],
  );
  const backupLastSuccess = registry.gauge(
    "needy_backup_last_success_timestamp_seconds",
    "Unix time the backup sidecar last uploaded a Postgres dump. Absent when unknown.",
  );
  const collectorFailures = registry.counter(
    "needy_metrics_collector_failures_total",
    "Scrape-time collectors that threw; their metrics are absent from that scrape.",
    ["collector"],
  );

  return {
    registry,
    httpRequests,
    httpDuration,
    sweepRuns,
    sweepFailures,
    sweepLastSuccess,
    socketConnections,
    sosOpen,
    sosOldestRaisedAge,
    uploadSlotsInUse,
    uploadSlotsMax,
    dependencyUp,
    backupLastSuccess,
    collectorFailures,
    recordSweep(sweep, ok, nowMs) {
      sweepRuns.inc({ sweep });
      if (ok) sweepLastSuccess.set({ sweep }, nowMs / 1000);
      else sweepFailures.inc({ sweep });
    },
  };
}

/**
 * The process-wide instance. A module singleton for the same reason `logger` is one: the
 * sweeps that report into it are module functions reached from many places, and threading a
 * metrics handle through every one of them would touch half the codebase for a counter.
 * Tests that assert on numbers build their own with `createAppMetrics()`.
 */
export const metrics: AppMetrics = createAppMetrics();

/**
 * Read the backup sidecar's last-success file: one line holding Unix seconds, written by
 * deploy/backup/backup.sh after an upload succeeded. Returns null for a missing, empty or
 * malformed file, which the collector turns into an absent metric — and the BackupMissing
 * alert in ops/alerts.yml fires on absence, so "cannot tell" is not mistaken for "fine".
 */
export async function readBackupTimestamp(
  path: string,
  read: (p: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<number | null> {
  let raw: string;
  try {
    raw = await read(path);
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d{9,11}$/.test(trimmed)) return null;
  return Number(trimmed);
}
