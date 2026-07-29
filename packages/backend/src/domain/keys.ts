/** All Redis key builders live here so modules never hand-roll key strings and can't
 *  drift apart. Presence, matching, tracking and rate-limiting all key off these. */
export const keys = {
  /** GEO set of helper positions used by matching's GEOSEARCH (§2.4). Members are userIds. */
  helperGeo: () => "geo:helpers",
  /** Hash of a user's presence record (state, activity, lastActiveAt). */
  presence: (userId: string) => `presence:${userId}`,
  /** Set of requester userIds subscribed to a given helper's presence (§2.2 scoping). */
  presenceSubs: (helperId: string) => `presence:subs:${helperId}`,
  /** Current (only) helper position for a task, TTL'd to task duration (§2.3). */
  taskLocation: (taskId: string) => `track:loc:${taskId}`,
  /** Distributed lock guarding first-accept-wins on a match (§2.4). */
  matchLock: (taskId: string) => `lock:match:${taskId}`,
  /** Set of helper userIds an offer for this task went out to, for offer-closed fan-out. */
  offerAudience: (taskId: string) => `match:offer:${taskId}`,
  /** Token-bucket state for a user's chat sends (§2.5 rate limit). */
  chatBucket: (userId: string) => `rl:chat:${userId}`,
} as const;
