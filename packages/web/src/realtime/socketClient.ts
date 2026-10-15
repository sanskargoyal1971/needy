import { Manager, type Socket } from "socket.io-client";
import {
  CLIENT_HEARTBEAT_INTERVAL_MS,
  NS,
  isTerminal,
  type ChatClientEvents,
  type ChatServerEvents,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type PublicTask,
  type PresenceClientEvents,
  type PresenceServerEvents,
  type SessionSnapshot,
  type SosAlert,
  type SosClientEvents,
  type SosKind,
  type SosServerEvents,
  type TaskState,
  type TrackingClientEvents,
  type TrackingServerEvents,
} from "@needy/shared";
import {
  initialTaskState,
  type ConnectionState,
  type NeedyDriver,
  type TaskExperienceState,
} from "./types.js";
import { nextMilestone } from "./milestones.js";

// socket.io-client's Socket is generic over <EventsItListensFor, EventsItEmits> — i.e. the
// server→client events first, client→server second.

export interface RealClientOptions {
  /** Origin of the backend, e.g. http://localhost:4000 (no namespace suffix). */
  baseUrl: string;
  /**
   * Short-lived JWT for the socket handshake and REST (§2.1).
   *
   * OPTIONAL, because it is no longer the primary auth path. The backend's socket middleware
   * (`socket/auth.ts`) prefers the httpOnly access cookie and only falls back to
   * `handshake.auth.token` / Bearer for dev tokens, tests and non-browser clients. A real
   * signed-in browser session therefore passes NO token and relies on `withCredentials`
   * below — which is the whole point of the cookies being httpOnly: there is nothing for a
   * script (ours or an attacker's) to read and forward.
   */
  token?: string;
  /** The authenticated user's id, to tell "me" from "the other party" in chat/typing. */
  userId: string;
}

/**
 * The production driver. One Socket.io Manager multiplexes the four namespaces over a single
 * connection with shared reconnect/backoff. The defining behavior (§2.1): on every (re)connect
 * we DON'T trust incoming events until we've re-synced authoritative state from GET /snapshot.
 * Until then the UI sits in `resyncing`, never silently pretending it's live.
 */
export class RealNeedyClient implements NeedyDriver {
  private state: TaskExperienceState;
  private readonly listeners = new Set<() => void>();
  private taskId: string | null = null;
  private typingClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** The single presence heartbeat interval (audit A2). Exactly one may exist at a time —
   *  see {@link startHeartbeat}. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Helper ids we've told /presence we care about, so we can unsubscribe again (audit B9).
   *  The server keeps a subscription set per helper; without a matching `unsubscribe` those
   *  sets grew forever and every completed task left a permanent fan-out entry behind. */
  private readonly presenceSubs = new Set<string>();
  private disposed = false;

  private readonly manager: Manager;
  private readonly presence: Socket<PresenceServerEvents, PresenceClientEvents>;
  private readonly tracking: Socket<TrackingServerEvents, TrackingClientEvents>;
  private readonly chat: Socket<ChatServerEvents, ChatClientEvents>;
  private readonly matching: Socket<MatchingServerEvents, MatchingClientEvents>;
  /** The requester's alarm channel. Previously absent entirely — see {@link raiseSos}. */
  private readonly sos: Socket<SosServerEvents, SosClientEvents>;

  constructor(private readonly opts: RealClientOptions) {
    this.state = initialTaskState(opts.userId);
    this.manager = new Manager(opts.baseUrl, {
      autoConnect: true,
      reconnection: true, // exponential backoff is the Socket.io default (§2.1)
      transports: ["websocket"],
      // Send the httpOnly auth cookies on the handshake. Without this a cookie-authenticated
      // browser session is anonymous to the socket middleware and every namespace refuses the
      // handshake — the same class of bug the audit found in `fetchSnapshot`.
      withCredentials: true,
    });
    // Omit `auth` entirely when there is no dev token, rather than sending `{ token: undefined }`:
    // the middleware's fallback chain reads `handshake.auth?.token` before the Bearer header, and
    // an explicit undefined is harmless but the empty object states the intent — cookies only.
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
    this.wirePresence();
    this.wireSos();
    this.wireHeartbeat();
  }

  // ── external store ─────────────────────────────────────────────────────────
  getState(): TaskExperienceState {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private patch(partial: Partial<TaskExperienceState>): void {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l();
  }
  private setConnection(connection: ConnectionState): void {
    if (this.state.connection !== connection) this.patch({ connection });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  start(taskId: string): void {
    this.taskId = taskId;
    // If already connected, resync + (re)join immediately; otherwise the connect handler will.
    if (this.matching.connected) void this.resyncAndJoin();
  }

  requestHelp(): void {
    if (!this.taskId) return;
    this.matching.emit("request-help", { taskId: this.taskId }, (res) => {
      if (!res.ok) console.warn("request-help rejected:", res.error);
    });
  }

  advanceTo(to: TaskState): void {
    if (!this.taskId) return;
    this.matching.emit("advance-task", { taskId: this.taskId, to }, (res) => {
      // We don't patch here — the authoritative `task-updated` broadcast (which we also
      // receive) is the single source of truth, keeping state consistent across clients.
      if (!res.ok) console.warn("advance-task rejected:", res.error);
    });
  }

  sendMessage(body: string): void {
    if (!this.taskId || body.trim().length === 0) return;
    const clientMsgId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    // The server echoes the authoritative message back over the room, so we append on receipt
    // rather than optimistically here — keeps ids/status consistent after a reconnect.
    this.chat.emit("send", { taskId: this.taskId, clientMsgId, body: body.trim() }, (res) => {
      if (!res.ok) console.warn("send rejected:", res.error);
    });
  }

  setTyping(isTyping: boolean): void {
    if (!this.taskId) return;
    this.chat.emit("typing", { taskId: this.taskId, isTyping });
  }

  markRead(messageIds: string[]): void {
    if (!this.taskId || messageIds.length === 0) return;
    this.chat.emit("mark-read", { taskId: this.taskId, messageIds });
  }

  // ── SOS ─────────────────────────────────────────────────────────────────────
  /**
   * Raise a durable alert and resolve with it, or resolve `null` if the server did not take
   * responsibility for it.
   *
   * The promise is the entire point, and its absence was the bug. `InTaskStage`'s button was a
   * local `useState` flag: pressing it played a red escalation animation and told the user help
   * was coming, while emitting nothing to any server. There was nothing to await because nothing
   * was ever sent. Here the UI may only claim "help has been notified" AFTER this resolves with
   * an alert, so a refused, rate-limited or unreachable alarm renders as a failure the user can
   * act on rather than as false reassurance during the emergency the control exists for.
   *
   * `at` is the task origin — the requester's own location — sent explicitly because the
   * server's fallback is the last TRACKED position, which belongs to the HELPER. Defaulting to
   * that would dispatch responders to the wrong person, and before `en-route` it doesn't exist
   * at all.
   */
  raiseSos(kind: SosKind, note?: string): Promise<SosAlert | null> {
    const taskId = this.taskId;
    const task = this.state.task;
    if (!taskId || this.disposed) return Promise.resolve(null);
    const at = task?.origin ?? null;
    return new Promise((resolve) => {
      // A dead socket must not leave the caller hanging forever on "sending…" — during an
      // emergency, an unresolved promise is indistinguishable from a working alarm.
      if (!this.sos.connected) {
        this.patch({
          lastError: { event: "raise", code: "INTERNAL", message: "not connected", taskId },
        });
        resolve(null);
        return;
      }
      this.sos.emit(
        "raise",
        { taskId, kind, ...(at ? { at } : {}), ...(note ? { note } : {}) },
        (res) => {
          if (res.ok) {
            this.patch({ sos: res.alert, lastError: null });
            resolve(res.alert);
          } else {
            this.patch({
              lastError: {
                event: "raise",
                code: res.error === "rate-limited" ? "RATE_LIMITED" : "INTERNAL",
                message: res.error,
                taskId,
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
            lastError: {
              event: "cancel",
              code: "INTERNAL",
              message: res.error,
              ...(this.taskId ? { taskId: this.taskId } : {}),
            },
          });
          resolve(false);
        }
      });
    });
  }

  dispose(): void {
    if (this.disposed) return; // idempotent: a double-dispose must not double-emit `leave`
    this.disposed = true;
    if (this.typingClearTimer) clearTimeout(this.typingClearTimer);
    this.stopHeartbeat();
    // Release server-side state we own BEFORE tearing the transport down (audit B9). Presence
    // subscription sets live in Redis and outlive the socket, so a disconnect alone leaks them.
    this.releaseSubscriptions();
    this.manager.removeAllListeners();
    for (const s of [this.presence, this.tracking, this.chat, this.matching, this.sos]) {
      s.removeAllListeners();
      s.disconnect();
    }
    this.listeners.clear();
  }

  // ── presence heartbeat (audit A2) ───────────────────────────────────────────
  /**
   * The client MUST beat, or the server's away-sweep flips this user to `away` after
   * AWAY_AFTER_MS (~37s) and matching — which filters candidates on `online-available` —
   * stops considering them entirely. The frontend previously emitted no heartbeat at all
   * from anywhere, so every real user became permanently unmatchable about half a minute
   * after connecting. The cadence lives in @needy/shared so client and server can't drift.
   */
  private wireHeartbeat(): void {
    // Bound to the /presence socket's own lifecycle: socket.io re-fires `connect` after every
    // successful reconnect, so this re-arms the beat automatically. startHeartbeat() clears any
    // prior interval first, which is what guarantees exactly ONE beat even if `connect` fires
    // again without an intervening `disconnect` — a leaked duplicate interval would double the
    // beat rate for the rest of the session.
    this.presence.on("connect", () => this.startHeartbeat());
    this.presence.on("disconnect", () => this.stopHeartbeat());
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.disposed) return;
    // No immediate beat: the server's /presence connection handler already stamps
    // `online-available` with a fresh lastActiveAt, so the first beat is due one interval on.
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

  // ── subscription bookkeeping (audit B9) ─────────────────────────────────────
  /** Subscribe to a helper's presence at most once, remembering it so we can release it. */
  private subscribePresence(helperId: string): void {
    if (this.presenceSubs.has(helperId)) return;
    this.presenceSubs.add(helperId);
    this.presence.emit("subscribe", { helperId });
  }

  /** Give back every room/subscription we hold. Called on a terminal task state and on
   *  dispose, so a finished task doesn't leave a permanent fan-out entry behind. */
  private releaseSubscriptions(): void {
    for (const helperId of this.presenceSubs) {
      if (this.presence.connected) this.presence.emit("unsubscribe", { helperId });
    }
    this.presenceSubs.clear();
    if (this.taskId) {
      if (this.tracking.connected) this.tracking.emit("leave", { taskId: this.taskId });
      if (this.chat.connected) this.chat.emit("leave", { taskId: this.taskId });
    }
  }

  // ── connection + reconnect/resync (§2.1) ────────────────────────────────────
  private wireConnection(): void {
    // Drive connection state off the matching socket; the Manager shares the transport.
    this.matching.on("connect", () => void this.resyncAndJoin());
    // `offline` vs `reconnecting` is a real distinction the UI must be able to make (audit
    // C22 — `offline` was declared but never assigned by any driver, so the honest "we are
    // not coming back on our own" case silently rendered as the reassuring "reconnecting").
    // These two reasons mean socket.io will NOT retry by itself; everything else will.
    this.matching.on("disconnect", (reason) => {
      const willRetry = reason !== "io client disconnect" && reason !== "io server disconnect";
      this.setConnection(willRetry ? "reconnecting" : "offline");
    });
    // `connect_error` covers BOTH a transient transport failure and a REFUSED handshake, and
    // they are opposite situations. When the server's auth middleware rejects the token (the
    // access JWT is short-lived and nothing here refreshes it, so an expired token is the
    // ordinary case, not an exotic one) socket.io calls `destroy()` on the socket before
    // emitting this: `socket.active` goes false and that namespace will NEVER be retried, even
    // though the Manager keeps happily reconnecting the underlying transport. Reporting that as
    // `reconnecting` leaves the user reading "hold on, we haven't lost your helper" forever
    // against a socket that is permanently dead — precisely the lie C22 exists to remove.
    // Checked as `=== false` so a socket stub without the getter can't be read as offline.
    this.matching.on("connect_error", () => {
      this.setConnection(this.matching.active === false ? "offline" : "reconnecting");
    });
    this.manager.on("reconnect_attempt", () => this.setConnection("reconnecting"));
    this.manager.on("error", () => this.setConnection("reconnecting"));
    // Backoff exhausted — stop implying a recovery that isn't being attempted. Note this is
    // belt-and-braces only: no `reconnectionAttempts` is configured, so socket.io defaults it
    // to Infinity and never actually emits this. The reachable permanent-failure paths are the
    // refused handshake above and a server-initiated disconnect.
    this.manager.on("reconnect_failed", () => this.setConnection("offline"));
  }

  /** The authoritative post-(re)connect sequence: re-sync from REST, THEN re-join live rooms. */
  private async resyncAndJoin(): Promise<void> {
    if (!this.taskId) {
      this.setConnection("online");
      return;
    }
    this.setConnection("resyncing");
    try {
      const snap = await this.fetchSnapshot();
      const entry = snap.activeTasks.find((t) => t.task.id === this.taskId);
      if (entry) {
        this.patch({
          task: entry.task,
          helper: entry.helper,
          location: entry.lastKnownLocation,
          eta: entry.eta,
          messages: entry.messages,
          presence: entry.presence,
          // Restored, not left to a live event that will never come: `sos-raised` fires once,
          // at the moment of the alarm, so a client that reloaded afterwards would otherwise
          // show an un-pressed alarm button over a live emergency.
          sos: entry.sos,
        });
        if (entry.helper) this.subscribePresence(entry.helper.id);
      } else {
        // The snapshot carries ACTIVE tasks only, so a finished or cancelled one — every link
        // in the request history — is absent from it, and the page used to spin forever.
        // Read that one task directly; a terminal task has no rooms worth joining.
        const res = await fetch(`${this.opts.baseUrl}/tasks/${encodeURIComponent(this.taskId)}`, {
          headers: this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {},
          credentials: "include",
        });
        if (res.status === 403 || res.status === 404) {
          this.patch({ taskUnavailable: true });
          this.setConnection("online");
          return;
        }
        if (!res.ok) throw new Error(`task ${res.status}`);
        const { task } = (await res.json()) as { task: PublicTask };
        this.patch({ task, taskUnavailable: false });
        if (isTerminal(task.state)) {
          this.setConnection("online");
          return;
        }
      }
    } catch (err) {
      console.warn("snapshot resync failed; will retry on next reconnect", err);
    }
    // Only now do we (re)join rooms and start trusting live events.
    this.tracking.emit("join", { taskId: this.taskId });
    this.chat.emit("join", { taskId: this.taskId });
    this.setConnection("online");
  }

  private async fetchSnapshot(): Promise<SessionSnapshot> {
    const res = await fetch(`${this.opts.baseUrl}/snapshot`, {
      // Only send a Bearer header when we actually hold a dev token. Sending
      // `Bearer undefined` for a cookie session would hand the server a malformed credential
      // to try before it ever reaches the cookie, turning a valid session into a 401.
      headers: this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {},
      // Cookies are the real auth path (the bearer above is the dev path), and a cross-origin
      // fetch drops them unless credentials are opted in — without this the snapshot 401s for
      // every cookie-authenticated user, which silently strands them in `resyncing`.
      credentials: "include",
    });
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    return (await res.json()) as SessionSnapshot;
  }

  // ── namespace wiring ────────────────────────────────────────────────────────
  private wireMatching(): void {
    this.matching.on("helpers-nearby", ({ taskId, count, approxPoints, restrictedNearby }) => {
      if (taskId !== this.taskId) return;
      this.patch({
        helpersNearby: { count, approxPoints, restrictedNearby: restrictedNearby ?? 0 },
      });
    });
    this.matching.on("matched", ({ task, helper }) => {
      if (task.id !== this.taskId) return;
      this.patch({ task, helper });
      this.subscribePresence(helper.id);
    });
    // Server-authoritative lifecycle transitions after match (Stage 3–7) arrive here.
    this.matching.on("task-updated", ({ task }) => {
      if (task.id !== this.taskId) return;
      this.patch({ task });
      // A completed/cancelled task will never produce another event, so hand back the rooms
      // and presence subscriptions now rather than holding them until the tab closes
      // (audit B9 — nothing on the client ever emitted `unsubscribe`/`leave`, so the server's
      // per-helper subscriber sets only ever grew).
      if (isTerminal(task.state)) this.releaseSubscriptions();
    });
    // `offer` / `offer-closed` are helper-side; a requester client ignores them.
  }

  private wireTracking(): void {
    this.tracking.on("helper-moved", ({ taskId, update }) => {
      if (taskId !== this.taskId) return;
      this.patch({ location: update });
    });
    this.tracking.on("eta", ({ taskId, etaSeconds, distanceMeters }) => {
      if (taskId !== this.taskId) return;
      const milestone = nextMilestone(
        this.state.eta?.etaSeconds ?? null,
        etaSeconds,
        this.state.helper,
      );
      this.patch({
        eta: { etaSeconds, distanceMeters },
        milestones: milestone ? [...this.state.milestones, milestone] : this.state.milestones,
      });
    });
  }

  private wireChat(): void {
    this.chat.on("message", (message) => {
      if (message.taskId !== this.taskId) return;
      // Ignore a re-broadcast of a message we already have (e.g. after resync).
      if (this.state.messages.some((m) => m.id === message.id)) return;
      this.patch({ messages: [...this.state.messages, message] });
    });
    this.chat.on("receipt-changed", ({ messageId, status }) => {
      this.patch({
        messages: this.state.messages.map((m) => (m.id === messageId ? { ...m, status } : m)),
      });
    });
    this.chat.on("helper-typing", ({ taskId, userId, isTyping }) => {
      if (taskId !== this.taskId || userId === this.opts.userId) return;
      this.patch({ otherTyping: isTyping });
      if (this.typingClearTimer) clearTimeout(this.typingClearTimer);
      if (isTyping) {
        // Safety auto-clear in case the "stopped typing" event is lost.
        this.typingClearTimer = setTimeout(() => this.patch({ otherTyping: false }), 4000);
      }
    });
  }

  private wirePresence(): void {
    this.presence.on("presence-changed", (presence) => {
      if (this.state.helper && presence.userId === this.state.helper.id) {
        this.patch({ presence });
      }
    });
  }

  /**
   * Accept alerts raised by EITHER party on this task.
   *
   * Not just our own: if the helper pulls the alarm — a helper alone in a stranger's home can
   * be the one at risk — the requester's screen must show that an alert is live rather than
   * carrying on as though the task were normal. The server broadcasts to both participants, so
   * this listener is what makes the alarm mutual instead of one-directional.
   */
  private wireSos(): void {
    const accept = (alert: SosAlert) => {
      if (this.taskId && alert.taskId !== this.taskId) return;
      this.patch({ sos: alert });
    };
    this.sos.on("sos-raised", accept);
    this.sos.on("sos-updated", accept);
    this.sos.on("error", (payload) => this.patch({ lastError: payload }));
  }
}
