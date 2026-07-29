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
  /** Generic token-bucket key for any rate-limited action (audit C20 — only chat was
   *  limited before, leaving request-help/accept/location/typing/subscribe unbounded). */
  bucket: (action: string, userId: string) => `rl:${action}:${userId}`,
  /** Freshness index for the helper GEO set: a sorted set of helperId → lastPublishedAt.
   *  Redis GEO members have no individual TTL, so availability decay is expressed here and
   *  swept; matching intersects the two so it never offers work to a phantom (audit A1). */
  helperGeoFresh: () => "geo:helpers:fresh",
  /** Sorted set of taskId → offerExpiresAt, swept to close lapsed offers durably instead
   *  of via an in-process setTimeout that a restart would lose (audit C19). */
  offerExpiryQueue: () => "match:offer:expiry",
  /** Dedup key mapping a chat clientMsgId → committed messageId, so a resend after a
   *  reconnect reconciles instead of double-posting (audit: clientMsgId was ignored). */
  chatDedup: (taskId: string, clientMsgId: string) =>
    `chat:dedup:${taskId}:${clientMsgId}`,
  /** Live socket count per user, so presence only flips offline at zero rather than when
   *  any one of several tabs closes — and stays correct across instances (audit B10). */
  socketCount: (userId: string) => `presence:sockets:${userId}`,
  /** Server-issued KYC challenge nonce, bound to the user who started verification, so a
   *  callback cannot self-verify an arbitrary account (audit A5). */
  kycNonce: (reference: string) => `kyc:nonce:${reference}`,
} as const;
