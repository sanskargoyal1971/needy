import type {
  ChatMessage,
  LatLng,
  MatchOffer,
  SocketErrorPayload,
  SosAlert,
  PublicTask,
  SosKind,
  TaskState,
} from "@needy/shared";
import type { ConnectionState, EtaView } from "./types.js";

/**
 * ── The helper side of the app (C2: "helper-side UI" was missing entirely) ────
 *
 * WHY THIS IS A SEPARATE CONTRACT rather than more methods on {@link NeedyDriver}.
 *
 * `NeedyDriver` is requester-shaped all the way down: `requestHelp()`, `helpersNearby`, a
 * single `task`, a `helper` to look at. The helper's world is genuinely a different shape —
 * they hold *no* task most of the time, they publish idle availability, they receive a
 * *list* of competing offers with expiry windows, and they are the one who reports position.
 * Folding all of that into the requester's view-model would have given every requester
 * screen fields that are permanently null and every helper screen fields that never apply.
 *
 * The two drivers deliberately DO share the transport-level rules that the audit found
 * broken, because those are properties of the protocol, not of one role:
 *   - A2: the client must beat on /presence or the away-sweep makes it unmatchable. The
 *     audit asked for this "both ways" — a helper that stops beating is worse than a
 *     requester that does, because matching filters candidates on `online-available`, so a
 *     silent helper simply stops receiving work with no visible symptom.
 *   - A1: idle availability is published on /presence's `publish-availability`, NEVER by
 *     writing the task-bound /tracking `location`. See {@link HelperDriver.reportPosition}.
 *   - §2.1: on every (re)connect, re-sync from GET /snapshot before trusting live events.
 *   - B13: `userId` is carried in the state, never guessed by a component.
 */

/** What a helper client renders from. One consolidated external-store value, same pattern
 *  as {@link TaskExperienceState}. */
export interface HelperExperienceState {
  connection: ConnectionState;
  /** The authenticated helper's own id (audit B13 — components must never infer this). */
  userId: string;
  /**
   * Whether we are currently advertising ourselves as available for work.
   *
   * This is the client's *intent*. The server's view is a TTL'd geo entry that decays if we
   * stop publishing (AVAILABILITY_TTL_MS), so the driver re-publishes on a timer while this
   * is true — a toggle that only published once would silently stop producing offers about a
   * minute later, which is exactly the class of invisible failure A1/A2 were about.
   */
  available: boolean;
  /** The last position we told the server about, so the UI can show what it actually knows
   *  rather than what the device most recently reported to the browser. */
  position: LatLng | null;
  /** Live offers, soonest-to-expire first. A helper may hold several at once — that is the
   *  point of a simultaneous broadcast — so this is a list, not a single "current offer". */
  offers: MatchOffer[];
  /** Why an offer left the list. Kept so the UI can say "that one went to someone else"
   *  instead of having a card silently vanish under the user's thumb. */
  lastClosed: {
    taskId: string;
    reason: "already-taken" | "expired" | "cancelled";
  } | null;
  /** The task we have accepted, if any. Null is the normal, most common state for a helper. */
  task: PublicTask | null;
  messages: ChatMessage[];
  /** Whether the REQUESTER is typing (the mirror of the requester view's `otherTyping`). */
  otherTyping: boolean;
  /** Our own ETA to the task origin, as computed by the server from our reported position. */
  eta: EtaView | null;
  /**
   * The live SOS alert on this task, if one has been raised.
   *
   * Deliberately NOT local component state. The audit's finding was that the SOS button was a
   * `useState` flag: arming it told no server, persisted nothing and reached no operator, so a
   * safety control that only *looked* like it worked turned a real emergency into a silent one.
   * This field is only ever set from the server's ack or its `sos-raised`/`sos-updated`
   * broadcast, which is what licenses the UI to claim help has actually been notified.
   *
   * Held for either party's alert, not just ours: a helper must be able to see that the
   * requester has raised the alarm.
   */
  sos: SosAlert | null;
  /**
   * The most recent server refusal, surfaced rather than swallowed.
   *
   * The audit's A3 requirement was that an unauthorized chat action "reject with a clear
   * error event, don't silently drop" — that only pays off if a client actually shows it.
   * A helper whose `location` is being refused (wrong state, rate limited, not the assigned
   * helper) otherwise sees a map that simply never moves, with nothing to act on.
   */
  lastError: SocketErrorPayload | null;
}

export function initialHelperState(userId: string): HelperExperienceState {
  return {
    connection: "connecting",
    userId,
    available: false,
    position: null,
    offers: [],
    lastClosed: null,
    task: null,
    messages: [],
    otherTyping: false,
    eta: null,
    sos: null,
    lastError: null,
  };
}

/** The actions a helper can take. Implemented by {@link RealHelperClient}. */
export interface HelperDriver {
  getState(): HelperExperienceState;
  subscribe(listener: () => void): () => void;

  /** Start or stop advertising availability. Turning it on publishes immediately and then
   *  keeps re-publishing before the server-side TTL lapses; turning it off publishes
   *  `available: false` once so the helper is de-listed straight away instead of lingering
   *  in the index until it ages out. */
  setAvailable(available: boolean): void;

  /**
   * Feed a new position in.
   *
   * ONE client-side entry point, TWO server-side destinations, chosen by whether we are on a
   * task (audit A1). Idle → `/presence` `publish-availability`, which is the only correct
   * writer of the availability geo index. On a live, trackable task → `/tracking` `location`,
   * which relays `helper-moved` to the requester. The server keeps these strictly separate
   * (conflating them is what produced the original discovery deadlock); the client picks the
   * right one rather than emitting both, because emitting both would re-advertise a helper who
   * is demonstrably busy.
   */
  reportPosition(
    point: LatLng,
    extras?: { heading?: number; speedMps?: number },
  ): void;

  /** Take an offer. The ack tells us whether we won the race; losing is normal, not an error. */
  accept(taskId: string): void;
  /** Pass on an offer, so it stops occupying the UI. */
  decline(taskId: string): void;

  /** Drive our accepted task forward. The server enforces both the state machine and the
   *  actor matrix, so the UI only offers edges this role may actually take. */
  advanceTo(to: TaskState): void;

  sendMessage(body: string): void;
  setTyping(isTyping: boolean): void;
  markRead(messageIds: string[]): void;

  /**
   * Pull the alarm. Resolves only once the server has acknowledged a DURABLE alert, so the UI
   * can distinguish "help has been notified" from "we tried" — the previous UI-only button
   * could not, and told the user the former while doing neither.
   *
   * Either participant may raise: a helper alone in a stranger's home can be the one at risk,
   * which is why this sits on the helper driver and not only the requester's.
   */
  raiseSos(kind: SosKind, note?: string): Promise<SosAlert | null>;
  /** Stand down a false alarm we raised. The record is kept, never deleted. */
  cancelSos(alertId: string): Promise<boolean>;

  /**
   * Acknowledge a finished (completed/cancelled) task and return to the availability screen.
   *
   * A terminal task deliberately STAYS on screen until the helper dismisses it, rather than the
   * requester's confirmation yanking the screen out from under them mid-read. That does mean
   * something has to clear it, and it must be the helper's own action — hence this rather than a
   * timer, which would take the closing words away from a slow reader.
   *
   * Ignores a non-terminal task: this must never be a way to abandon live work, which is what
   * `advanceTo("cancelled")` is for.
   */
  dismissFinishedTask(): void;

  dispose(): void;
}
