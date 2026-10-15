import type { AppMetrics } from "./appMetrics.js";
import { readBackupTimestamp } from "./appMetrics.js";
import type { SosRepository } from "../domain/sosStore.js";
import { probe } from "../http/router.js";

/**
 * Where the scrape-time numbers come from. Every field is a narrow function or interface
 * rather than `Deps`, so a test can hand in exactly the source it is asserting on, and so it is
 * visible at a glance that nothing here can reach a user record.
 */
export interface ScrapeSources {
  /** Open connections per namespace on this process; null before the socket server exists. */
  sockets: () => Record<string, number> | null;
  sos: Pick<SosRepository, "openSummary">;
  uploads: { inUse: () => number; max: number };
  /** Each probe resolves when the dependency answered. Postgres is omitted in in-memory mode,
   *  where there is nothing to be down, the same way /health reports "not-configured". */
  probes: { redis: () => Promise<unknown>; postgres?: () => Promise<unknown> };
  /** Path of the backup sidecar's last-success file, or "" when backups are not wired here. */
  backupStatusFile: string;
  readFile?: (path: string) => Promise<string>;
  now: () => number;
  probeTimeoutMs?: number;
}

/** Wire the scrape-time collectors onto `m`. Call once per registry. */
export function registerScrapeCollectors(m: AppMetrics, src: ScrapeSources): void {
  const timeoutMs = src.probeTimeoutMs ?? 2_000;

  m.registry.collect("sockets", () => {
    const counts = src.sockets();
    m.socketConnections.clear();
    if (!counts) return;
    for (const [namespace, n] of Object.entries(counts)) {
      m.socketConnections.set({ namespace }, n);
    }
  });

  m.registry.collect("sos", async () => {
    try {
      const s = await src.sos.openSummary();
      m.sosOpen.set({ status: "raised" }, s.raised);
      m.sosOpen.set({ status: "acknowledged" }, s.acknowledged);
      m.sosOldestRaisedAge.set(
        undefined,
        s.oldestRaisedAt == null ? 0 : Math.max(0, (src.now() - s.oldestRaisedAt) / 1000),
      );
    } catch (err) {
      // Absent, not stale: see Gauge.clear. The SosOpenAlertsUnknown alert fires on absence.
      m.sosOpen.clear();
      m.sosOldestRaisedAge.clear();
      throw err;
    }
  });

  m.registry.collect("uploads", () => {
    m.uploadSlotsInUse.set(undefined, src.uploads.inUse());
    m.uploadSlotsMax.set(undefined, src.uploads.max);
  });

  m.registry.collect("dependencies", async () => {
    const [redisOk, pgOk] = await Promise.all([
      probe(src.probes.redis, timeoutMs),
      src.probes.postgres ? probe(src.probes.postgres, timeoutMs) : Promise.resolve(null),
    ]);
    m.dependencyUp.set({ dependency: "redis" }, redisOk ? 1 : 0);
    if (pgOk !== null) m.dependencyUp.set({ dependency: "postgres" }, pgOk ? 1 : 0);
  });

  if (src.backupStatusFile) {
    m.registry.collect("backup", async () => {
      const ts = await readBackupTimestamp(src.backupStatusFile, src.readFile);
      if (ts == null) m.backupLastSuccess.clear();
      else m.backupLastSuccess.set(undefined, ts);
    });
  }
}
