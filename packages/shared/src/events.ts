import type { LatLng, LocationUpdate } from "./geo.js";
import type { Presence } from "./presence.js";
import type { PublicTask, TaskState } from "./task.js";

/** Socket.io namespace-per-concern (§2.1). Keep these as the only source of namespace
 *  strings so client and server can never disagree. */
export const NS = {
  presence: "/presence",
  tracking: "/tracking",
  chat: "/chat",
  matching: "/matching",
  sos: "/sos",
} as const;
export type Namespace = (typeof NS)[keyof typeof NS];

/** Every namespace surfaces refusals on this one channel rather than dropping payloads
 *  silently. `code` is machine-readable so a client can branch (re-auth, back off, drop a
 *  stale subscription); `message` is for logs, never for display to a user as-is. */
export interface SocketErrorPayload {
  event: string;
  code:
    | "AUTH_REQUIRED"
    | "INVALID_PAYLOAD"
    | "NOT_A_PARTICIPANT"
    | "NOT_TASK_HELPER"
    | "NOT_AUTHORIZED"
    | "RATE_LIMITED"
    | "NOT_FOUND"
    | "INTERNAL";
  message: string;
  taskId?: string;
}

/** ── /presence ─────────────────────────────────────────────────────────────
 *  Presence changes are broadcast only to subscribers of a given helper (§2.2),
 *  never globally. `subscribe`/`unsubscribe` scope who receives updates. */
export interface PresenceClientEvents {
  heartbeat: () => void;
  "set-activity": (activity: Presence["activity"]) => void;
  subscribe: (payload: { helperId: string }) => void;
  unsubscribe: (payload: { helperId: string }) => void;
  /**
   * IDLE availability publish (audit A1). A helper who is on no task at all publishes
   * their position here so matching's GEOSEARCH can find them. This is deliberately
   * SEPARATE from `/tracking`'s `location`: that event is task-bound (it relays
   * `helper-moved` to a requester watching a live task), whereas this one only says
   * "I am available around here". Conflating them is what produced the original
   * deadlock — the only writer to the geo index required already being matched.
   *
   * Requires a helper-capable role and `kyc: "verified"`; entries are TTL'd so a helper
   * who vanishes ages out of the index instead of lingering as a phantom candidate.
   */
  "publish-availability": (
    payload: { point: LatLng; available: boolean },
    ack?: (result: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
}
export interface PresenceServerEvents {
  "presence-changed": (presence: Presence) => void;
  error: (payload: SocketErrorPayload) => void;
}

/** ── /tracking ─────────────────────────────────────────────────────────────
 *  Helper client emits `location` every 3–5s while a task is active (§2.3).
 *  Server relays `helper-moved` to the requester and pushes recomputed `eta`. */
export interface TrackingClientEvents {
  join: (payload: { taskId: string }) => void;
  leave: (payload: { taskId: string }) => void;
  location: (payload: {
    taskId: string;
    point: LatLng;
    heading?: number;
    speedMps?: number;
  }) => void;
}
export interface TrackingServerEvents {
  "helper-moved": (payload: { taskId: string; update: LocationUpdate }) => void;
  eta: (payload: { taskId: string; etaSeconds: number; distanceMeters: number }) => void;
  error: (payload: SocketErrorPayload) => void;
}

/** ── /chat ─────────────────────────────────────────────────────────────────
 *  Typing indicators (§2.5) and sent→delivered→read receipts. */
export type ReceiptStatus = "sent" | "delivered" | "read";
export interface ChatMessage {
  id: string;
  taskId: string;
  senderId: string;
  body: string;
  createdAt: number;
  status: ReceiptStatus;
}
export interface ChatClientEvents {
  join: (payload: { taskId: string }) => void;
  leave: (payload: { taskId: string }) => void;
  send: (
    payload: { taskId: string; clientMsgId: string; body: string },
    ack: (result: { ok: true; message: ChatMessage } | { ok: false; error: string }) => void,
  ) => void;
  typing: (payload: { taskId: string; isTyping: boolean }) => void;
  "mark-read": (payload: { taskId: string; messageIds: string[] }) => void;
}
export interface ChatServerEvents {
  message: (message: ChatMessage) => void;
  "helper-typing": (payload: { taskId: string; userId: string; isTyping: boolean }) => void;
  "receipt-changed": (payload: {
    taskId: string;
    messageId: string;
    status: ReceiptStatus;
  }) => void;
  error: (payload: SocketErrorPayload) => void;
}

/** ── /matching ─────────────────────────────────────────────────────────────
 *  Offers broadcast to multiple eligible helpers simultaneously with an accept
 *  window; first-accept-wins under a distributed lock (§2.4). */
export interface MatchOffer {
  taskId: string;
  category: PublicTask["category"];
  origin: LatLng;
  title: string;
  distanceMeters: number;
  /** epoch ms after which the offer expires and stops being acceptable. */
  expiresAt: number;
}
export interface MatchingClientEvents {
  /** requester opens a search; server begins broadcasting offers to eligible helpers. */
  "request-help": (
    payload: { taskId: string },
    ack: (result: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
  /** helper accepts an offer; ack tells them whether they won the race. */
  accept: (
    payload: { taskId: string },
    ack: (
      result: { won: true; task: PublicTask } | { won: false; reason: "already-taken" | "expired" },
    ) => void,
  ) => void;
  decline: (payload: { taskId: string }) => void;
  /** Drive a matched task through its lifecycle (matched → verifying → … → completed, or
   *  cancelled). Server enforces the TASK_TRANSITIONS state machine + participant auth and
   *  broadcasts `task-updated` to both parties. */
  "advance-task": (
    payload: { taskId: string; to: TaskState },
    ack: (result: { ok: true; task: PublicTask } | { ok: false; error: string }) => void,
  ) => void;
}
/** ── SOS (audit: previously UI-only) ───────────────────────────────────────
 *  The SOS button used to be local `useState` — arming it notified nobody, persisted
 *  nothing, and reached no operator. For an app aimed at vulnerable users that is the
 *  most serious kind of gap: the control implies a promise of help that did not exist.
 *
 *  An alert is durable (Postgres) so it survives a restart and can be audited after the
 *  fact, and is acknowledged back to the raiser so the UI can honestly say "help has
 *  been notified" rather than only looking like it did. */
export type SosKind = "panic" | "medical" | "unsafe" | "other";
export type SosStatus = "raised" | "acknowledged" | "resolved" | "cancelled";

export interface SosAlert {
  id: string;
  taskId: string;
  /** Who pulled the alarm. Either participant may — a helper can be at risk too. */
  raisedBy: string;
  kind: SosKind;
  status: SosStatus;
  /** Last known position of the raiser, so responders have somewhere to go. */
  at: LatLng | null;
  note: string | null;
  /** The operator who took ownership, and when. This is the field the raiser's UI is allowed
   *  to read "a person is looking at this" from — and it is null until one actually is. */
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
  /** Who closed it, and what they found. A resolution with no account of what happened is
   *  indistinguishable from someone clearing their queue. */
  resolvedBy: string | null;
  resolutionNote: string | null;
  /** How many on-call pages have gone out because nobody acknowledged this alert. 0 means
   *  none yet. Kept apart from `escalationTier` because once every tier has been tried the
   *  top one is paged again rather than left alone, so the two stop moving together.
   *
   *  STAFF-ONLY, like the two fields after it. Only the operator feed and the admin API carry
   *  the real values; every channel that reaches a participant resets all three to their
   *  unescalated values (the backend's `participantSosView`). There, 0 means "not disclosed",
   *  not "nobody was paged". */
  escalationStep: number;
  /** The on-call tier most recently paged (1 = first). 0 until the first page. */
  escalationTier: number;
  /** When that page went out, so the console can say "escalated to tier 2 at 12:01". */
  escalatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Build a `SosAlert` from the fields a raiser supplies, defaulting the operator-lifecycle
 * fields to their un-handled state.
 *
 * Same rationale as `makeTask` and `makeUser`: this interface has grown once and will grow
 * again, and without a factory every new field must be added by hand at every construction
 * site — where the one that gets missed is `undefined` at runtime while typechecking fine.
 * For this type in particular a missed `acknowledgedBy` would render as "an operator has
 * seen this" in a console that reads truthiness, which is the exact lie this file exists to
 * prevent.
 */
export function makeSosAlert(
  seed: Pick<SosAlert, "id" | "taskId" | "raisedBy" | "kind"> & Partial<SosAlert>,
): SosAlert {
  return {
    status: "raised",
    at: null,
    note: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    escalationStep: 0,
    escalationTier: 0,
    escalatedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...seed,
  };
}

/** Alerts an operator still owes an answer to. `cancelled` is excluded because the raiser
 *  themselves stood it down; `resolved` because an operator closed it. */
export const OPEN_SOS_STATUSES: readonly SosStatus[] = ["raised", "acknowledged"];

export function isSosOpen(alert: SosAlert): boolean {
  return OPEN_SOS_STATUSES.includes(alert.status);
}

export interface SosClientEvents {
  raise: (
    payload: { taskId: string; kind: SosKind; at?: LatLng; note?: string },
    ack: (result: { ok: true; alert: SosAlert } | { ok: false; error: string }) => void,
  ) => void;
  /** Stand down a false alarm. Deliberately still recorded, never deleted. */
  cancel: (
    payload: { alertId: string },
    ack: (result: { ok: true; alert: SosAlert } | { ok: false; error: string }) => void,
  ) => void;
  /**
   * Subscribe to every live alert on the platform — the operator console's feed.
   *
   * Admin-only, and the check is against the DURABLE user record rather than the JWT's `role`
   * claim: an access token lives 15 minutes, so a demoted or compromised admin would otherwise
   * keep a window onto every emergency on the platform for the remainder of its life. The ack
   * carries the currently-open queue so the console renders a correct backlog immediately
   * instead of appearing empty until the next alarm.
   */
  watch: (
    ack: (result: { ok: true; open: SosAlert[] } | { ok: false; error: string }) => void,
  ) => void;
  /** Drop the operator feed without dropping the socket. */
  unwatch: () => void;
}

export interface SosServerEvents {
  /** To both participants + any operator listener: an alert is live on this task. */
  "sos-raised": (alert: SosAlert) => void;
  "sos-updated": (alert: SosAlert) => void;
  error: (payload: SocketErrorPayload) => void;
}

export interface MatchingServerEvents {
  /** delivered to eligible helpers when a nearby request opens. */
  offer: (offer: MatchOffer) => void;
  /** delivered to helpers who didn't win, so their UI can resolve gracefully. */
  "offer-closed": (payload: {
    taskId: string;
    reason: "already-taken" | "expired" | "cancelled";
  }) => void;
  /** delivered to the requester as helpers are found / when matched. */
  /**
   * How the search is going, per wave.
   *
   * `restrictedNearby` is the count of helpers who were in range, available, KYC-verified and
   * offering the right service — and were excluded ONLY by the eligibility matrix. It exists
   * because without it a refused search is indistinguishable from an empty neighbourhood: the
   * requester watches "asking helpers closest to you first" forever while the one person 2
   * metres away is silently filtered out, and nothing on screen ever says why. A deliberate
   * refusal that the person it refuses cannot see is the worst of both worlds — they get
   * neither the match nor the explanation.
   *
   * A COUNT only. Never who, never where: these are people the requester is specifically not
   * cleared to be matched with, so naming them would leak exactly what the rule exists to
   * withhold.
   */
  "helpers-nearby": (payload: {
    taskId: string;
    count: number;
    approxPoints: LatLng[];
    restrictedNearby?: number;
  }) => void;
  matched: (payload: { task: PublicTask; helper: MatchedHelper }) => void;
  /** delivered to BOTH participants whenever the task's lifecycle state changes after match. */
  "task-updated": (payload: { task: PublicTask }) => void;
  error: (payload: SocketErrorPayload) => void;
}

/** The human-framed helper card the reveal moment renders (§3 Stage 2). */
export interface MatchedHelper {
  id: string;
  displayName: string;
  photoUrl: string;
  rating: number;
  helpedCount: number;
  etaSeconds: number | null;
}

/** ── reconnect snapshot (§2.1) ────────────────────────────────────────────
 *  On reconnect the client MUST re-sync from this REST snapshot before trusting
 *  new socket events. It is the authoritative post-drop truth. */
export interface TaskSnapshot {
  task: PublicTask;
  helper: MatchedHelper | null;
  lastKnownLocation: LocationUpdate | null;
  eta: { etaSeconds: number; distanceMeters: number } | null;
  messages: ChatMessage[];
  presence: Presence | null;
  /**
   * The live alarm on this task, if one has been raised by either party.
   *
   * Part of the snapshot because the snapshot is what a client rebuilds itself from after a
   * drop or a reload, and an alarm is the one thing that must survive that. Without it,
   * someone who raised an alarm and then reloaded — or whose phone dropped the socket, which
   * is not unlikely in the situations this button exists for — came back to an un-pressed
   * alarm button, with nothing on screen saying an alarm was ever raised. They would
   * reasonably conclude it had not been, and the other party's warning that their companion
   * is in trouble would silently disappear too.
   *
   * `SosRepository.activeForTask` was written for this and its own comment says so; nothing
   * ever called it.
   */
  sos: SosAlert | null;
}

export interface SessionSnapshot {
  userId: string;
  serverTime: number;
  activeTasks: TaskSnapshot[];
}

export const TASK_STATES_WITH_LIVE_TRACKING: readonly TaskState[] = ["en-route", "arrived"];
