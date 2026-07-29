import type { LatLng, LocationUpdate } from "./geo.js";
import type { Presence } from "./presence.js";
import type { Task, TaskState } from "./task.js";

/** Socket.io namespace-per-concern (§2.1). Keep these as the only source of namespace
 *  strings so client and server can never disagree. */
export const NS = {
  presence: "/presence",
  tracking: "/tracking",
  chat: "/chat",
  matching: "/matching",
} as const;
export type Namespace = (typeof NS)[keyof typeof NS];

/** ── /presence ─────────────────────────────────────────────────────────────
 *  Presence changes are broadcast only to subscribers of a given helper (§2.2),
 *  never globally. `subscribe`/`unsubscribe` scope who receives updates. */
export interface PresenceClientEvents {
  heartbeat: () => void;
  "set-activity": (activity: Presence["activity"]) => void;
  subscribe: (payload: { helperId: string }) => void;
  unsubscribe: (payload: { helperId: string }) => void;
}
export interface PresenceServerEvents {
  "presence-changed": (presence: Presence) => void;
}

/** ── /tracking ─────────────────────────────────────────────────────────────
 *  Helper client emits `location` every 3–5s while a task is active (§2.3).
 *  Server relays `helper-moved` to the requester and pushes recomputed `eta`. */
export interface TrackingClientEvents {
  join: (payload: { taskId: string }) => void;
  leave: (payload: { taskId: string }) => void;
  location: (payload: { taskId: string; point: LatLng; heading?: number; speedMps?: number }) => void;
}
export interface TrackingServerEvents {
  "helper-moved": (payload: { taskId: string; update: LocationUpdate }) => void;
  eta: (payload: { taskId: string; etaSeconds: number; distanceMeters: number }) => void;
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
  "receipt-changed": (payload: { taskId: string; messageId: string; status: ReceiptStatus }) => void;
}

/** ── /matching ─────────────────────────────────────────────────────────────
 *  Offers broadcast to multiple eligible helpers simultaneously with an accept
 *  window; first-accept-wins under a distributed lock (§2.4). */
export interface MatchOffer {
  taskId: string;
  category: Task["category"];
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
    ack: (result: { won: true; task: Task } | { won: false; reason: "already-taken" | "expired" }) => void,
  ) => void;
  decline: (payload: { taskId: string }) => void;
  /** Drive a matched task through its lifecycle (matched → verifying → … → completed, or
   *  cancelled). Server enforces the TASK_TRANSITIONS state machine + participant auth and
   *  broadcasts `task-updated` to both parties. */
  "advance-task": (
    payload: { taskId: string; to: TaskState },
    ack: (result: { ok: true; task: Task } | { ok: false; error: string }) => void,
  ) => void;
}
export interface MatchingServerEvents {
  /** delivered to eligible helpers when a nearby request opens. */
  offer: (offer: MatchOffer) => void;
  /** delivered to helpers who didn't win, so their UI can resolve gracefully. */
  "offer-closed": (payload: { taskId: string; reason: "already-taken" | "expired" | "cancelled" }) => void;
  /** delivered to the requester as helpers are found / when matched. */
  "helpers-nearby": (payload: { taskId: string; count: number; approxPoints: LatLng[] }) => void;
  matched: (payload: { task: Task; helper: MatchedHelper }) => void;
  /** delivered to BOTH participants whenever the task's lifecycle state changes after match. */
  "task-updated": (payload: { task: Task }) => void;
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
  task: Task;
  helper: MatchedHelper | null;
  lastKnownLocation: LocationUpdate | null;
  eta: { etaSeconds: number; distanceMeters: number } | null;
  messages: ChatMessage[];
  presence: Presence | null;
}

export interface SessionSnapshot {
  userId: string;
  serverTime: number;
  activeTasks: TaskSnapshot[];
}

export const TASK_STATES_WITH_LIVE_TRACKING: readonly TaskState[] = [
  "en-route",
  "arrived",
];
