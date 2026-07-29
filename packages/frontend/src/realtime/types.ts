import type {
  ChatMessage,
  LatLng,
  LocationUpdate,
  MatchedHelper,
  Presence,
  Task,
  TaskState,
} from "@needy/shared";

/** Connection lifecycle surfaced to the UI. `reconnecting` is a first-class, visible state
 *  (§2.1) — the app must never silently pretend it's live during a drop. */
export type ConnectionState =
  | "connecting"
  | "online"
  | "reconnecting"
  | "resyncing" // reconnected socket, re-syncing from /snapshot before trusting events
  | "offline";

export interface EtaView {
  etaSeconds: number;
  distanceMeters: number;
}

/**
 * The single consolidated view-model a task experience renders from. Every stage component
 * reads slices of this; it's assembled by whichever driver is active (real socket client or
 * the scripted mock). `task.state` is the switch that decides which stage is on screen.
 */
export interface TaskExperienceState {
  connection: ConnectionState;
  task: Task | null;
  /** Requester-side: helpers surfacing during the search (§3 Stage 1). */
  helpersNearby: { count: number; approxPoints: LatLng[] };
  /** The matched, KYC-verified helper (§3 Stage 2). */
  helper: MatchedHelper | null;
  /** Latest interpolation target for the map marker (§3 Stage 4). */
  location: LocationUpdate | null;
  eta: EtaView | null;
  messages: ChatMessage[];
  /** Whether the OTHER party is currently typing (§3 Stage 6). */
  otherTyping: boolean;
  /** The helper's live presence, shown as human context rather than a dot (§2.2). */
  presence: Presence | null;
  /** Human "warmth" milestones crossed en route, newest last (e.g. "Priya is 5 min away"). */
  milestones: string[];
}

export function initialTaskState(): TaskExperienceState {
  return {
    connection: "connecting",
    task: null,
    helpersNearby: { count: 0, approxPoints: [] },
    helper: null,
    location: null,
    eta: null,
    messages: [],
    otherTyping: false,
    presence: null,
    milestones: [],
  };
}

/**
 * The contract every driver implements. A React-facing external store (getState/subscribe)
 * plus the actions a requester can take. The real client and the mock are interchangeable
 * behind this, which is what lets the whole lifecycle be exercised without a live backend.
 */
export interface NeedyDriver {
  getState(): TaskExperienceState;
  subscribe(listener: () => void): () => void;
  /** Begin observing a task: join its rooms and seed state from the reconnect snapshot. */
  start(taskId: string): void;
  /** Requester opens the search (Stage 1 → matching). */
  requestHelp(): void;
  /** Drive the matched task to a new lifecycle state (server validates the transition). */
  advanceTo(to: TaskState): void;
  sendMessage(body: string): void;
  setTyping(isTyping: boolean): void;
  markRead(messageIds: string[]): void;
  dispose(): void;
}

export type { ChatMessage, MatchedHelper, Task, TaskState, LocationUpdate, Presence, LatLng };
