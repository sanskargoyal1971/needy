import { Manager, type Socket } from "socket.io-client";
import {
  NS,
  type ChatClientEvents,
  type ChatServerEvents,
  type MatchingClientEvents,
  type MatchingServerEvents,
  type PresenceClientEvents,
  type PresenceServerEvents,
  type SessionSnapshot,
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
  /** Short-lived JWT reused for the socket handshake and REST (§2.1). */
  token: string;
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
  private state = initialTaskState();
  private readonly listeners = new Set<() => void>();
  private taskId: string | null = null;
  private typingClearTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly manager: Manager;
  private readonly presence: Socket<PresenceServerEvents, PresenceClientEvents>;
  private readonly tracking: Socket<TrackingServerEvents, TrackingClientEvents>;
  private readonly chat: Socket<ChatServerEvents, ChatClientEvents>;
  private readonly matching: Socket<MatchingServerEvents, MatchingClientEvents>;

  constructor(private readonly opts: RealClientOptions) {
    this.manager = new Manager(opts.baseUrl, {
      autoConnect: true,
      reconnection: true, // exponential backoff is the Socket.io default (§2.1)
      transports: ["websocket"],
    });
    const auth = { token: opts.token };
    this.presence = this.manager.socket(NS.presence, { auth }) as never;
    this.tracking = this.manager.socket(NS.tracking, { auth }) as never;
    this.chat = this.manager.socket(NS.chat, { auth }) as never;
    this.matching = this.manager.socket(NS.matching, { auth }) as never;

    this.wireConnection();
    this.wireMatching();
    this.wireTracking();
    this.wireChat();
    this.wirePresence();
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

  dispose(): void {
    if (this.typingClearTimer) clearTimeout(this.typingClearTimer);
    this.manager.removeAllListeners();
    for (const s of [this.presence, this.tracking, this.chat, this.matching]) {
      s.removeAllListeners();
      s.disconnect();
    }
    this.listeners.clear();
  }

  // ── connection + reconnect/resync (§2.1) ────────────────────────────────────
  private wireConnection(): void {
    // Drive connection state off the matching socket; the Manager shares the transport.
    this.matching.on("connect", () => void this.resyncAndJoin());
    this.matching.on("disconnect", () => this.setConnection("reconnecting"));
    this.manager.on("reconnect_attempt", () => this.setConnection("reconnecting"));
    this.manager.on("error", () => this.setConnection("reconnecting"));
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
        });
        if (entry.helper) this.presence.emit("subscribe", { helperId: entry.helper.id });
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
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    return (await res.json()) as SessionSnapshot;
  }

  // ── namespace wiring ────────────────────────────────────────────────────────
  private wireMatching(): void {
    this.matching.on("helpers-nearby", ({ taskId, count, approxPoints }) => {
      if (taskId !== this.taskId) return;
      this.patch({ helpersNearby: { count, approxPoints } });
    });
    this.matching.on("matched", ({ task, helper }) => {
      if (task.id !== this.taskId) return;
      this.patch({ task, helper });
      this.presence.emit("subscribe", { helperId: helper.id });
    });
    // Server-authoritative lifecycle transitions after match (Stage 3–7) arrive here.
    this.matching.on("task-updated", ({ task }) => {
      if (task.id !== this.taskId) return;
      this.patch({ task });
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
      const milestone = nextMilestone(this.state.eta?.etaSeconds ?? null, etaSeconds, this.state.helper);
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
        messages: this.state.messages.map((m) =>
          m.id === messageId ? { ...m, status } : m,
        ),
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
}
