import type {
  ChatMessage,
  LatLng,
  LocationUpdate,
  MatchedHelper,
  Presence,
  SocketErrorPayload,
  SosAlert,
  PublicTask,
  SosKind,
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
  /** Straight-line estimate rather than a routed one. */
  approximate?: boolean;
  /** Encoded road route from the helper to the task origin, when one was routed. */
  polyline?: string;
}

/**
 * The single consolidated view-model a task experience renders from. Every stage component
 * reads slices of this; it's assembled by whichever driver is active (real socket client or
 * the scripted mock). `task.state` is the switch that decides which stage is on screen.
 */
export interface TaskExperienceState {
  connection: ConnectionState;
  /**
   * The authenticated user's own id, carried in the view-model on purpose (audit B13).
   * Every stage needs to tell "mine" from "the other party's" — chat alignment, receipts,
   * which messages to mark read — and the DRIVER is the only thing that actually knows who
   * we are. It used to be guessed with a `const ME = "me"` in InTaskStage, which is only
   * true for the scripted mock: live user ids look like `req-a1b2c3`, so in live mode every
   * message the user sent rendered as if the helper had sent it, receipts never appeared,
   * and the mark-read effect marked the user's OWN messages as read. Threading it through
   * here fixes it once, at the root, for every consumer.
   */
  userId: string;
  task: PublicTask | null;
  /** Requester-side: helpers surfacing during the search (§3 Stage 1). */
  helpersNearby: {
    count: number;
    approxPoints: LatLng[];
    /**
     * Helpers who were in range and available, and whom the eligibility matrix refused.
     *
     * The requester cannot be told who or where — those are precisely the people they are not
     * cleared to be matched with. But they must be told that this is what happened: without
     * it, a deliberate refusal and an empty neighbourhood look identical, and the person sits
     * watching a radar that will never resolve.
     */
    restrictedNearby: number;
  };
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
  /**
   * The live SOS alert on this task, if one has been raised — by EITHER party.
   *
   * Deliberately NOT local component state, for exactly the reason the helper side documents
   * in {@link HelperExperienceState.sos}. The requester's SOS button was a `useState` flag
   * driving a convincing red escalation animation that emitted nothing: `NeedyDriver` had no
   * `raiseSos` at all, so the one control in the product whose entire purpose is summoning
   * help reached nobody. A safety control that only *looks* like it worked converts a real
   * emergency into a silent one, which is strictly worse than having no button.
   *
   * Only ever set from the server's ack or its `sos-raised`/`sos-updated` broadcast. That is
   * what licenses the UI to say "help has been notified" — before this field is populated the
   * UI may only say it is trying.
   */
  sos: SosAlert | null;
  /**
   * The most recent server refusal, surfaced rather than swallowed (mirrors the helper side).
   *
   * Load-bearing for SOS specifically: a rate-limited or refused alarm must be visible as a
   * failure the user can act on — call someone — never as a reassuring animation over a
   * request the server rejected.
   */
  lastError: SocketErrorPayload | null;
  /**
   * The task does not exist or is not this user's. Distinct from `task: null`, which means
   * "still loading": without it a wrong or foreign link spun a loader forever.
   */
  taskUnavailable: boolean;
}

/** `userId` is required rather than defaulted so a driver can never silently ship an
 *  anonymous identity into the chat comparison and reintroduce audit B13. */
export function initialTaskState(userId: string): TaskExperienceState {
  return {
    connection: "connecting",
    userId,
    task: null,
    helpersNearby: { count: 0, approxPoints: [], restrictedNearby: 0 },
    helper: null,
    location: null,
    eta: null,
    messages: [],
    otherTyping: false,
    presence: null,
    milestones: [],
    sos: null,
    lastError: null,
    taskUnavailable: false,
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

  /**
   * Pull the alarm. Resolves only once the server has acknowledged a DURABLE alert, so the UI
   * can distinguish "help has been notified" from "we tried".
   *
   * Deliberately identical in shape to {@link HelperDriver.raiseSos} — this is a property of
   * the protocol, not of one role, and the requester side lacking it entirely is what let the
   * button ship as an animation with no network call behind it. Either participant may raise.
   *
   * Resolving `null` is a real, expected outcome (refused, rate-limited, socket down) and the
   * caller MUST render it as a failure with an alternative course of action, never swallow it.
   */
  raiseSos(kind: SosKind, note?: string): Promise<SosAlert | null>;
  /** Stand down a false alarm. The record is kept server-side, never deleted. */
  cancelSos(alertId: string): Promise<boolean>;

  dispose(): void;
}

export type {
  ChatMessage,
  MatchedHelper,
  PublicTask,
  Task,
  TaskState,
  LocationUpdate,
  Presence,
  LatLng,
  SosAlert,
  SosKind,
  SocketErrorPayload,
};
