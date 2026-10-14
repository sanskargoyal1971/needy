import { phoneIndex } from "../crypto/pii.js";

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
  /** Sorted set of SOS alertId → when its next on-call escalation is due. Same shape and same
   *  reason as the offer-expiry queue: a timer in process memory dies with the process, and an
   *  unanswered alarm is the last thing a restart may quietly drop. */
  sosEscalationQueue: () => "sos:escalation",
  /** Which radius wave a live search is on (0 = 1km, 1 = 5km, 2 = 10km). Kept in Redis
   *  rather than in process memory for the same reason the expiry schedule is: a restart
   *  mid-search must still escalate rather than stranding the requester at 1km forever. */
  offerWave: (taskId: string) => `match:wave:${taskId}`,
  /** Failed handoff-code attempts for a task. Short-lived, so it lives in Redis rather than
   *  as a column on the hot tasks table. */
  handoffAttempts: (taskId: string) => `handoff:attempts:${taskId}`,
  /** An admin who has passed the password step and still owes the one-time code. Holds a
   *  DIGEST of a single-use token, not the token — a read-only leak of Redis must not hand
   *  someone the half-finished login of the account that can see every emergency. Named by
   *  the number's blind index rather than the number, for the same reason as the OTP keys. */
  mfaPending: (phone: string) => `auth:mfa:${phoneIndex(phone)}`,
  /** A member of staff who has passed the password step and still owes an authenticator code
   *  — or, for a super admin with no authenticator yet, still owes enrolling one. Keyed by the
   *  DIGEST of the single-use token, for the same reason as above; the value says whose
   *  half-finished login it is and which of those two things it may be used for. */
  totpPending: (tokenHash: string) => `auth:totp:${tokenHash}`,
  /** Dedup key mapping a chat clientMsgId → committed messageId, so a resend after a
   *  reconnect reconciles instead of double-posting (audit: clientMsgId was ignored). */
  chatDedup: (taskId: string, clientMsgId: string) => `chat:dedup:${taskId}:${clientMsgId}`,
  /** Live socket count per user, so presence only flips offline at zero rather than when
   *  any one of several tabs closes — and stays correct across instances (audit B10). */
  socketCount: (userId: string) => `presence:sockets:${userId}`,
  /** Server-issued KYC challenge nonce, bound to the user who started verification, so a
   *  callback cannot self-verify an arbitrary account (audit A5). */
  kycNonce: (reference: string) => `kyc:nonce:${reference}`,
} as const;
