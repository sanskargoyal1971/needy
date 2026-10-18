import { Manager, type Socket } from "socket.io-client";
import {
  AVAILABILITY_TTL_MS,
  CLIENT_HEARTBEAT_INTERVAL_MS,
  NS,
  TASK_STATES_WITH_LIVE_TRACKING,
  isAwaitingNamedHelper,
  isCommittedHelper,
  isTerminal,
  type ChatClientEvents,
  type ChatServerEvents,
  type LatLng,
  type MatchOffer,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type PresenceClientEvents,
  type PresenceServerEvents,
  type SessionSnapshot,
  type SocketErrorPayload,
  type SosAlert,
  type SosClientEvents,
  type SosKind,
  type SosServerEvents,
  type TaskState,
  type TrackingClientEvents,
  type TrackingServerEvents,
} from "@needy/shared";
import {
  initialHelperState,
  type HelperDriver,
  type HelperExperienceState,
} from "./helperTypes.js";
import type { ConnectionState } from "./types.js";

export interface HelperClientOptions {
  /** Origin of the backend, e.g. http://localhost:4000 (no namespace suffix). */
  baseUrl: string;
  /**
   * Short-lived JWT for the socket handshake and REST (§2.1).
   *
   * OPTIONAL — see the same note on {@link RealClientOptions}. The backend's socket middleware
   * prefers the httpOnly access cookie and only falls back to `handshake.auth.token` for dev
   * tokens, tests and non-browser clients, so a real signed-in browser passes none.
   */
  token?: string;
  /** The authenticated helper's own id (audit B13). */
  userId: string;
}

/**
 * How often we re-publish availability while the toggle is on.
 *
 * The server TTLs availability entries at AVAILABILITY_TTL_MS (~51s) because Redis GEO has no
 * per-member expiry, so freshness is expressed by a companion set that a sweep prunes. A
 * client that published once would therefore be dropped from the candidate pool about a minute
 * later while its UI still said "You're available" — the same shape of invisible failure as
 * A1/A2. A third of the TTL means two consecutive publishes can be lost (a tunnel, a
 * backgrounded tab) before we actually age out.
 */
const AVAILABILITY_REPUBLISH_MS = Math.floor(AVAILABILITY_TTL_MS / 3);

/** Drop an offer from the UI shortly after its window lapses even if no `offer-closed`
 *  arrives — the server's sweep may be up to an interval behind, and a card that can no
 *  longer be accepted must not keep inviting a tap. */
const OFFER_EXPIRY_GRACE_MS = 1_000;

/**
 * The production helper driver.
 *
 * Mirrors {@link RealNeedyClient}'s transport discipline (one Manager, resync-before-trust,
 * a single presence heartbeat, released subscriptions on dispose) but models the helper's
 * actual job: publish idle availability, receive competing offers, win one, report position,
 * and drive the task forward.
 *
 * The load-bearing distinction (audit A1) is in {@link reportPosition}: idle position goes to
 * `/presence` `publish-availability` and in-task position goes to `/tracking` `location`, never
 * both. `/tracking` de-lists the helper from the availability index on every tick precisely so
 * that a helper on a live task stops being offered more work, so a client that also kept
 * publishing availability would be fighting the server for no benefit.
 */
export class RealHelperClient implements HelperDriver {
  private state: HelperExperienceState;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private availabilityTimer: ReturnType<typeof setInterval> | null = null;
  private typingClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** One expiry timer per live offer, so a lapsed card disappears without waiting on a
   *  server broadcast. Keyed by taskId and always cleared before being replaced. */
  private readonly offerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Task rooms we have joined, so a reconnect re-joins exactly what we held. */
  private joinedTaskId: string | null = null;
  /**
   * Bumped every time a LIVE event decides what task we hold.
   *
   * Guards the snapshot resync against its own latency (see {@link resyncAndJoin}). A snapshot
   * is only authoritative as of the moment it was requested, and on a phone that request can
   * easily be in flight for a second — long enough for an `accept` ack or a `matched` broadcast
   * to arrive and be strictly newer than the answer coming back.
   */
  private taskEpoch = 0;

  private readonly manager: Manager;
  private readonly presence: Socket<PresenceServerEvents, PresenceClientEvents>;
  private readonly tracking: Socket<TrackingServerEvents, TrackingClientEvents>;
  private readonly chat: Socket<ChatServerEvents, ChatClientEvents>;
  private readonly matching: Socket<MatchingServerEvents, MatchingClientEvents>;
  private readonly sos: Socket<SosServerEvents, SosClientEvents>;

  constructor(private readonly opts: HelperClientOptions) {
    this.state = initialHelperState(opts.userId);
    this.manager = new Manager(opts.baseUrl, {
      autoConnect: true,
      reconnection: true,
      transports: ["websocket"],
      // Send the httpOnly auth cookies on the handshake — without this a cookie-authenticated
      // browser session is anonymous to the socket middleware and every namespace refuses it.
      withCredentials: true,
    });
    const auth = opts.token ? { token: opts.token } : {};
    this.presence = this.manager.socket(NS.presence, { auth }) as never;
    this.tracking = this.manager.socket(NS.tracking, { auth }) as never;
    this.chat = this.manager.socket(NS.chat, { auth }) as never;
    this.matching = this.manager.socket(NS.matching, { auth }) as never;
    this.sos = this.manager.socket(NS.sos, { auth }) as never;

    this.wireConnection();
    this.wireMatching();
    this.wireTracking();
    this.wireChat();
    this.wireSos();
    this.wireErrors();
    this.wireHeartbeat();
  }

  // ── external store ─────────────────────────────────────────────────────────
  getState(): HelperExperienceState {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private patch(partial: Partial<HelperExperienceState>): void {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l();
  }
  private setConnection(connection: ConnectionState): void {
    if (this.state.connection !== connection) this.patch({ connection });
  }

  // ── availability (audit A1, helper side) ────────────────────────────────────
  setAvailable(available: boolean): void {
    if (this.disposed) return;
    this.patch({ available });
    if (available) {
      // Publish straight away so the helper is findable now, not one interval from now, then
      // keep the entry warm. Without a position we can't publish anything meaningful yet —
      // the first reportPosition() will publish as soon as one arrives.
      this.publishAvailability();
      this.startAvailabilityRepublish();
    } else {
      this.stopAvailabilityRepublish();
      // Explicitly de-list rather than letting the TTL lapse: a helper who just switched off
      // should not receive an offer for the next ~50 seconds. Needs a point because the
      // contract carries one; the server only reads `available` to decide to remove.
      const point = this.state.position;
      if (point && this.presence.connected) {
        this.presence.emit("publish-availability", { point, available: false });
      }
    }
  }

  private startAvailabilityRepublish(): void {
    this.stopAvailabilityRepublish();
    if (this.disposed) return;
    this.availabilityTimer = setInterval(
      () => this.publishAvailability(),
      AVAILABILITY_REPUBLISH_MS,
    );
  }

  private stopAvailabilityRepublish(): void {
    if (this.availabilityTimer !== null) {
      clearInterval(this.availabilityTimer);
      this.availabilityTimer = null;
    }
  }

  /** Publish the last known position as an availability advertisement, if we should be
   *  advertising at all. Silent no-op otherwise — deliberately, because this is also the
   *  timer callback and a helper who went on a task must not keep advertising. */
  private publishAvailability(): void {
    const point = this.state.position;
    if (!this.state.available || !point) return;
    if (this.isOnLiveTask()) return;
    if (!this.presence.connected) return;
    this.presence.emit("publish-availability", { point, available: true }, (res) => {
      // The server refuses a helper who is on a live task — usually a reload that published
      // before the task snapshot arrived. Not an error and not a reason to switch them off:
      // the snapshot makes this client stop on its own, and after the task they are simply
      // available again.
      if (!res.ok && res.error === "on-a-task") return;
      if (!res.ok) {
        // The common refusal here is an unverified helper: the server hard-filters on
        // `kyc: "verified"` (B11), so an unverified account can never be offered work. That
        // must be visible — otherwise the toggle sits on "Available" forever and no offer
        // ever comes, with nothing on screen to explain why.
        this.patch({
          available: false,
          lastError: {
            event: "publish-availability",
            code: "NOT_AUTHORIZED",
            message: res.error,
          },
        });
        this.stopAvailabilityRepublish();
      }
    });
  }

  /** True when we hold a task the server considers live-trackable, i.e. when position belongs
   *  on /tracking rather than /presence. Uses the SAME shared list the server gates on, so the
   *  client can't drift into emitting `location` in a state that will be refused. */
  private isOnLiveTask(): boolean {
    const state = this.state.task?.state;
    return state != null && TASK_STATES_WITH_LIVE_TRACKING.includes(state);
  }

  reportPosition(point: LatLng, extras: { heading?: number; speedMps?: number } = {}): void {
    if (this.disposed) return;
    this.patch({ position: point });

    if (this.isOnLiveTask() && this.state.task) {
      // On a live task: this is task-bound tracking, relayed to the requester as
      // `helper-moved` + a recomputed `eta`. NOT an availability publish (audit A1).
      this.tracking.emit("location", {
        taskId: this.state.task.id,
        point,
        ...(extras.heading != null ? { heading: extras.heading } : {}),
        ...(extras.speedMps != null ? { speedMps: extras.speedMps } : {}),
      });
      return;
    }
    // Idle: this is an availability advertisement and nothing else.
    this.publishAvailability();
  }

  // ── offers ─────────────────────────────────────────────────────────────────
  accept(taskId: string): void {
    if (this.disposed) return;
    this.matching.emit("accept", { taskId }, (res) => {
      if (res.won) {
        // Don't wait for the `matched` broadcast to update the UI — the ack IS the
        // authoritative "you won" and arrives first. `matched` then also lands and is
        // idempotent with this.
        this.dropOffer(taskId);
        // This ack is strictly newer than any snapshot already in flight, so mark it — see
        // the epoch note in resyncAndJoin. Without it, an HTTP round-trip that started before
        // the tap can land after the win and erase the task the helper just accepted.
        this.taskEpoch += 1;
        // `sos: null` because an alert belongs to ONE task; carrying a previous task's alarm
        // onto a new one would show a stranger's emergency to the wrong helper.
        this.patch({ task: res.task, lastClosed: null, sos: null, messages: [] });
        this.joinTaskRooms(res.task.id);
        // Won a task ⇒ stop advertising. The server de-lists us on the first /tracking tick
        // anyway, but that only happens once we go en-route, and until then we would still
        // be a candidate for someone else's request.
        this.stopAvailabilityRepublish();
        this.patch({ available: false });
      } else {
        this.dropOffer(taskId);
        this.patch({ lastClosed: { taskId, reason: res.reason } });
      }
    });
  }

  decline(taskId: string): void {
    if (this.disposed) return;
    this.matching.emit("decline", { taskId });
    this.dropOffer(taskId);
  }

  private addOffer(offer: MatchOffer): void {
    // A duplicate offer for the same task (a re-broadcast after a reconnect) replaces the
    // existing one rather than stacking a second card for the same request.
    const others = this.state.offers.filter((o) => o.taskId !== offer.taskId);
    const offers = [...others, offer].sort((a, b) => a.expiresAt - b.expiresAt);
    this.patch({ offers });

    const existing = this.offerTimers.get(offer.taskId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, offer.expiresAt - Date.now()) + OFFER_EXPIRY_GRACE_MS;
    this.offerTimers.set(
      offer.taskId,
      setTimeout(() => {
        // Only mark it closed if it is still on screen — a won or declined offer has already
        // been removed and must not resurrect a "that offer expired" notice.
        if (this.state.offers.some((o) => o.taskId === offer.taskId)) {
          this.dropOffer(offer.taskId);
          this.patch({ lastClosed: { taskId: offer.taskId, reason: "expired" } });
        }
      }, delay),
    );
  }

  private dropOffer(taskId: string): void {
    const timer = this.offerTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.offerTimers.delete(taskId);
    }
    if (this.state.offers.some((o) => o.taskId === taskId)) {
      this.patch({ offers: this.state.offers.filter((o) => o.taskId !== taskId) });
    }
  }

  // ── task actions ───────────────────────────────────────────────────────────
  advanceTo(to: TaskState): void {
    const task = this.state.task;
    if (!task) return;
    this.matching.emit("advance-task", { taskId: task.id, to }, (res) => {
      // No optimistic patch: `task-updated` is the authoritative broadcast and we receive it
      // too, so both participants converge on one server-decided state.
      if (!res.ok) {
        this.patch({
          lastError: {
            event: "advance-task",
            code: "NOT_AUTHORIZED",
            message: res.error,
            taskId: task.id,
          },
        });
      }
    });
  }

  sendMessage(body: string): void {
    const task = this.state.task;
    if (!task || body.trim().length === 0) return;
    const clientMsgId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    this.chat.emit("send", { taskId: task.id, clientMsgId, body: body.trim() }, (res) => {
      if (!res.ok) {
        this.patch({
          lastError: {
            event: "send",
            code: "INTERNAL",
            message: res.error,
            taskId: task.id,
          },
        });
      }
    });
  }

  setTyping(isTyping: boolean): void {
    const task = this.state.task;
    if (!task) return;
    this.chat.emit("typing", { taskId: task.id, isTyping });
  }

  markRead(messageIds: string[]): void {
    const task = this.state.task;
    if (!task || messageIds.length === 0) return;
    this.chat.emit("mark-read", { taskId: task.id, messageIds });
  }

  dismissFinishedTask(): void {
    const task = this.state.task;
    // Guarded on terminality on purpose: this is a "clear the closing screen" action, never an
    // escape hatch from live work. Abandoning an in-flight task has to go through
    // advanceTo("cancelled") so the requester is actually told.
    if (!task || !isTerminal(task.state)) return;
    this.patch({ task: null, messages: [], eta: null, sos: null, otherTyping: false });
  }

  // ── SOS ────────────────────────────────────────────────────────────────────
  /**
   * Raise a durable alert and resolve with it, or resolve `null` if the server did not accept
   * responsibility for it.
   *
   * The promise is the point. The old button flipped a local flag synchronously and the UI
   * immediately claimed help was coming; there was nothing to await because nothing was sent.
   * Here the UI may only make that claim after this resolves with an alert, so a rate-limited,
   * refused or unreachable alarm is visibly a failure the user can act on (call someone) rather
   * than a false reassurance.
   *
   * `at` is our last reported position, sent explicitly rather than relying on the server's
   * fallback: the server falls back to the task's last TRACKED location, which for a helper who
   * has not gone en-route yet does not exist.
   */
  raiseSos(kind: SosKind, note?: string): Promise<SosAlert | null> {
    const task = this.state.task;
    if (!task || this.disposed) return Promise.resolve(null);
    const at = this.state.position;
    return new Promise((resolve) => {
      // A dead socket must not leave the caller hanging on a promise that never settles — the
      // UI would sit on "sending…" indefinitely during exactly the emergency it exists for.
      if (!this.sos.connected) {
        this.patch({
          lastError: {
            event: "raise",
            code: "INTERNAL",
            message: "not connected",
            taskId: task.id,
          },
        });
        resolve(null);
        return;
      }
      this.sos.emit(
        "raise",
        {
          taskId: task.id,
          kind,
          ...(at ? { at } : {}),
          ...(note ? { note } : {}),
        },
        (res) => {
          if (res.ok) {
            this.patch({ sos: res.alert });
            resolve(res.alert);
          } else {
            this.patch({
              lastError: {
                event: "raise",
                code: res.error === "rate-limited" ? "RATE_LIMITED" : "INTERNAL",
                message: res.error,
                taskId: task.id,
              },
            });
            resolve(null);
          }
        },
      );
    });
  }

  cancelSos(alertId: string): Promise<boolean> {
    if (this.disposed || !this.sos.connected) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.sos.emit("cancel", { alertId }, (res) => {
        if (res.ok) {
          this.patch({ sos: res.alert });
          resolve(true);
        } else {
          this.patch({
            lastError: { event: "cancel", code: "INTERNAL", message: res.error },
          });
          resolve(false);
        }
      });
    });
  }

  dispose(): void {
    if (this.disposed) return; // idempotent — a double dispose must not double-emit
    this.disposed = true;
    this.stopHeartbeat();
    this.stopAvailabilityRepublish();
    if (this.typingClearTimer) clearTimeout(this.typingClearTimer);
    for (const t of this.offerTimers.values()) clearTimeout(t);
    this.offerTimers.clear();
    // Give back server-side state we own before the transport goes (audit B9): the
    // availability index entry would otherwise keep us offerable for up to the TTL after the
    // tab closed, and an offer to a helper who isn't there costs the requester real time.
    if (this.state.position && this.presence.connected) {
      this.presence.emit("publish-availability", {
        point: this.state.position,
        available: false,
      });
    }
    if (this.joinedTaskId) {
      if (this.tracking.connected) this.tracking.emit("leave", { taskId: this.joinedTaskId });
      if (this.chat.connected) this.chat.emit("leave", { taskId: this.joinedTaskId });
    }
    this.manager.removeAllListeners();
    for (const s of [this.presence, this.tracking, this.chat, this.matching, this.sos]) {
      s.removeAllListeners();
      s.disconnect();
    }
    this.listeners.clear();
  }

  // ── presence heartbeat (audit A2, helper side) ───────────────────────────────
  /** Same requirement as the requester client, with sharper consequences: the away-sweep flips
   *  a silent helper to `away`, and matching only considers `online-available` candidates, so a
   *  helper that doesn't beat quietly stops receiving work while their UI still says they're
   *  available. */
  private wireHeartbeat(): void {
    this.presence.on("connect", () => {
      this.startHeartbeat();
      // A reconnect gets a fresh presence row (`online-available`, `idle`) but NOT a fresh geo
      // entry, so re-assert availability immediately rather than waiting for the republish
      // interval — otherwise a helper who reconnects mid-window is unfindable until it fires.
      if (this.state.available) {
        this.publishAvailability();
        this.startAvailabilityRepublish();
      }
    });
    this.presence.on("disconnect", () => {
      this.stopHeartbeat();
      // Nothing to publish into; the timer would only queue emits on a dead socket.
      this.stopAvailabilityRepublish();
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.disposed) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.presence.connected) this.presence.emit("heartbeat");
    }, CLIENT_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── connection + resync (§2.1) ───────────────────────────────────────────────
  private wireConnection(): void {
    this.matching.on("connect", () => void this.resyncAndJoin());
    this.matching.on("disconnect", (reason) => {
      // These two reasons mean socket.io will NOT retry on its own (audit C22), so claiming
      // "reconnecting" would be a lie the helper acts on by waiting.
      const willRetry = reason !== "io client disconnect" && reason !== "io server disconnect";
      this.setConnection(willRetry ? "reconnecting" : "offline");
    });
    this.matching.on("connect_error", () => this.setConnection("reconnecting"));
    this.manager.on("reconnect_attempt", () => this.setConnection("reconnecting"));
    this.manager.on("error", () => this.setConnection("reconnecting"));
    this.manager.on("reconnect_failed", () => this.setConnection("offline"));
  }

  /**
   * Re-sync from REST, then re-join rooms.
   *
   * A helper's snapshot is where an accepted task is RECOVERED after a reload — the offer that
   * produced it is long gone from Redis, so without this a helper who refreshed mid-task would
   * come back to an empty "no work" screen while the requester's app still showed them en
   * route. `activeForUser` returns tasks on either side, so we pick the one we hold as helper.
   *
   * ── WHY THE EPOCH GUARD ──────────────────────────────────────────────────
   * A snapshot describes the server as of when it was REQUESTED, and the await in between is
   * real time on a real network. Two live events can land inside that window:
   *
   *   - the `accept` ack, which is the authoritative "you won" and arrives on the socket while
   *     an HTTP round-trip is still open. Applying the snapshot afterwards would erase the task
   *     the helper has just been told they hold — they tapped Accept, saw it land, and watched
   *     it vanish;
   *   - a `matched` re-broadcast, same shape.
   *
   * So the stale-clearing branch below (which exists for the genuine "the requester cancelled
   * while you were offline" case) is only allowed to fire if nothing newer has decided the
   * question in the meantime. Comparing the epoch captured before the fetch against the one
   * after is what distinguishes "the server says you hold nothing" from "the server hadn't
   * heard about it yet when we asked".
   */
  private async resyncAndJoin(): Promise<void> {
    this.setConnection("resyncing");
    const epoch = this.taskEpoch;
    try {
      const snap = await this.fetchSnapshot();
      // Only a task this helper has COMMITTED to is "the task". An unconfirmed booking used to
      // match here too, which put a booking days away on screen as if they were doing it now
      // — hiding the availability toggle until the day came.
      const mine = snap.activeTasks.find((t) => isCommittedHelper(t.task, this.opts.userId));
      this.patch({
        upcoming: snap.activeTasks
          .map((t) => t.task)
          .filter((t) => t.helperId === this.opts.userId && isAwaitingNamedHelper(t))
          .sort((a, b) => (a.scheduledFor ?? a.createdAt) - (b.scheduledFor ?? b.createdAt)),
      });
      if (mine) {
        // Safe to apply even if a live event raced us: this IS the task, and the snapshot
        // carries the message history the socket does not replay.
        this.patch({
          task: mine.task,
          messages: mine.messages,
          eta: mine.eta,
          // See the requester client: `sos-raised` fires once and is not replayed, so an
          // alarm raised before this client (re)connected exists only in the snapshot.
          sos: mine.sos,
        });
        this.joinTaskRooms(mine.task.id);
      } else if (
        epoch === this.taskEpoch &&
        this.state.task &&
        !isTerminal(this.state.task.state)
      ) {
        // Nothing newer intervened, so the snapshot's silence is real: the task is gone (e.g.
        // cancelled while we were offline) and must come off the screen.
        this.patch({ task: null, messages: [], eta: null, sos: null });
      }
    } catch {
      // Leave state as-is and retry on the next reconnect. A failed HTTP call is not evidence a
      // task ended, and clearing it would drop a helper out of a task they are physically in
      // the middle of.
      this.patch({
        lastError: {
          event: "snapshot",
          code: "INTERNAL",
          message: "could not re-sync with the server",
        },
      });
    }
    this.setConnection("online");
  }

  private joinTaskRooms(taskId: string): void {
    this.joinedTaskId = taskId;
    this.tracking.emit("join", { taskId });
    this.chat.emit("join", { taskId });
  }

  private async fetchSnapshot(): Promise<SessionSnapshot> {
    const res = await fetch(`${this.opts.baseUrl}/snapshot`, {
      // Only send a Bearer header when we actually hold a dev token — `Bearer undefined` is a
      // malformed credential the server would try before ever reaching the cookie, turning a
      // valid cookie session into a 401.
      headers: this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {},
      // Cookies are the real auth path; a cross-origin fetch drops them without this.
      credentials: "include",
    });
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    return (await res.json()) as SessionSnapshot;
  }

  // ── namespace wiring ────────────────────────────────────────────────────────
  private wireMatching(): void {
    this.matching.on("offer", (offer) => {
      // Ignore offers while we already hold a task: accepting a second one would strand the
      // first requester. The server would refuse it anyway, but a card we can't act on is
      // just a trap.
      if (this.state.task && !isTerminal(this.state.task.state)) return;
      this.addOffer(offer);
    });

    this.matching.on("offer-closed", ({ taskId, reason }) => {
      this.dropOffer(taskId);
      this.patch({ lastClosed: { taskId, reason } });
    });

    this.matching.on("matched", ({ task }) => {
      if (task.helperId !== this.opts.userId) return;
      this.dropOffer(task.id);
      // Idempotent with the `accept` ack, which usually lands first — but only clear the
      // per-task fields if this is genuinely a DIFFERENT task, or a re-broadcast would wipe
      // messages already received on the current one.
      const isNew = this.state.task?.id !== task.id;
      this.taskEpoch += 1;
      this.patch({
        task,
        lastClosed: null,
        // A booking just confirmed is no longer "coming up" — it is now.
        upcoming: this.state.upcoming.filter((t) => t.id !== task.id),
        ...(isNew ? { sos: null, messages: [] } : {}),
      });
      this.joinTaskRooms(task.id);
    });

    this.matching.on("task-updated", ({ task }) => {
      if (this.state.task?.id !== task.id) return;
      this.patch({ task });
      if (isTerminal(task.state)) {
        // The task is over: hand back the rooms and become available again rather than
        // sitting in a finished task forever (audit B9).
        if (this.tracking.connected) this.tracking.emit("leave", { taskId: task.id });
        if (this.chat.connected) this.chat.emit("leave", { taskId: task.id });
        this.joinedTaskId = null;
      }
    });
  }

  private wireTracking(): void {
    // Our own ETA to the pickup, echoed back from the server's computation. The helper sees
    // the same number the requester does, which matters when they talk about it in chat.
    this.tracking.on("eta", ({ taskId, etaSeconds, distanceMeters, approximate, polyline }) => {
      if (taskId !== this.state.task?.id) return;
      this.patch({ eta: { etaSeconds, distanceMeters, approximate, polyline } });
    });
  }

  private wireChat(): void {
    this.chat.on("message", (message) => {
      if (message.taskId !== this.state.task?.id) return;
      if (this.state.messages.some((m) => m.id === message.id)) return;
      this.patch({ messages: [...this.state.messages, message] });
    });
    this.chat.on("receipt-changed", ({ messageId, status }) => {
      this.patch({
        messages: this.state.messages.map((m) => (m.id === messageId ? { ...m, status } : m)),
      });
    });
    this.chat.on("helper-typing", ({ taskId, userId, isTyping }) => {
      // The event name is historical — it carries EITHER party's typing state, so filtering on
      // "not me" is what makes it mean "the requester" here.
      if (taskId !== this.state.task?.id || userId === this.opts.userId) return;
      this.patch({ otherTyping: isTyping });
      if (this.typingClearTimer) clearTimeout(this.typingClearTimer);
      if (isTyping) {
        this.typingClearTimer = setTimeout(() => this.patch({ otherTyping: false }), 4000);
      }
    });
  }

  /**
   * Both directions of the alarm.
   *
   * `sos-raised` matters most when WE did not raise it: the requester pulling the alarm on a
   * task we are on is something the helper must see, not something only an operator sees.
   * Filtering on task id keeps a stale alert from a previous task off the screen.
   */
  private wireSos(): void {
    this.sos.on("sos-raised", (alert) => {
      if (alert.taskId !== this.state.task?.id) return;
      this.patch({ sos: alert });
    });
    this.sos.on("sos-updated", (alert) => {
      if (alert.taskId !== this.state.task?.id) return;
      // Cancelled/resolved alerts clear the banner; anything else keeps it live. The record
      // itself is retained server-side either way — we are only deciding what to show.
      const done = alert.status === "cancelled" || alert.status === "resolved";
      this.patch({ sos: done ? null : alert });
    });
  }

  /**
   * Surface every namespace's refusals instead of dropping them.
   *
   * A3 required the server to "reject with a clear error event, don't silently drop"; this is
   * the other half of that bargain. For a helper the refusals are especially consequential —
   * `NOT_AUTHORIZED` on `location` means the requester's map is frozen, `RATE_LIMITED` means
   * position updates are being shed — and every one of them is invisible unless shown.
   */
  private wireErrors(): void {
    const onError = (payload: SocketErrorPayload): void => {
      this.patch({ lastError: payload });
    };
    this.presence.on("error", onError);
    this.tracking.on("error", onError);
    this.chat.on("error", onError);
    this.matching.on("error", onError);
    this.sos.on("error", onError);
  }
}
