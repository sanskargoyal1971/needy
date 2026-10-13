/** Presence is never a bare boolean (§2.2). It carries an activity context so the UI can
 *  show human framing ("heading to a task") instead of a flat dot. */
export type PresenceState = "online-available" | "online-busy" | "away" | "offline";

/** Human-readable context that rides alongside the presence state so requesters see
 *  "Priya is heading to a task nearby" rather than a green/grey dot. */
export type ActivityContext = "idle" | "heading-to-task" | "in-task" | "just-finished-nearby";

export interface Presence {
  userId: string;
  state: PresenceState;
  activity: ActivityContext;
  /** epoch ms of last verified activity (heartbeat or event). */
  lastActiveAt: number;
}

/** Heartbeat cadence and the away threshold (§2.1). We flip to `away` only after
 *  MISSED_HEARTBEATS_BEFORE_AWAY consecutive misses to avoid flicker in dead zones. */
export const HEARTBEAT_INTERVAL_MS = 17_000;
export const MISSED_HEARTBEATS_BEFORE_AWAY = 2;
export const AWAY_AFTER_MS = HEARTBEAT_INTERVAL_MS * MISSED_HEARTBEATS_BEFORE_AWAY + 3_000;

/** How often a CLIENT should beat. Comfortably under HEARTBEAT_INTERVAL_MS so a single
 *  dropped beat never trips the away sweep (audit A2 — the frontend previously never beat
 *  at all, so every real user went `away` after AWAY_AFTER_MS and, because matching filters
 *  on `online-available`, became permanently unmatchable). */
export const CLIENT_HEARTBEAT_INTERVAL_MS = 8_000;

/** TTL on a helper's entry in the availability geo index and on presence-subscription
 *  entries (audit B9). Refreshed by each heartbeat/publish, so anything that stops beating
 *  ages out on its own rather than lingering as a phantom (Redis GEO has no per-member
 *  TTL, hence the companion freshness set — see backend domain/location-store). */
export const AVAILABILITY_TTL_MS = HEARTBEAT_INTERVAL_MS * 3;
