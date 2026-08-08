import { canTransition, makeTask } from "@needy/shared";
import type {
  ChatMessage,
  LatLng,
  MatchedHelper,
  SosAlert,
  SosKind,
  Task,
  TaskState,
} from "@needy/shared";
import {
  initialTaskState,
  type NeedyDriver,
  type TaskExperienceState,
} from "./types.js";
import { nextMilestone } from "./milestones.js";

const ORIGIN: LatLng = { lat: 12.9716, lng: 77.5946 };
/** Default identity for the scripted requester. Callers may override it, and every place the
 *  mock used to hardcode `"me"` now reads `this.userId` — the same field the real client
 *  publishes — so the UI can never again assume a literal id (audit B13). */
const DEFAULT_USER_ID = "mock-me";
/** How far from the origin the scripted helpers scatter, in degrees (~1.1 km). Roughly the
 *  radius SearchingStage's radar projects, so the blips land inside it. */
const MOCK_SPREAD_DEG = 0.01;
const HELPER: MatchedHelper = {
  id: "helper-priya",
  displayName: "Priya",
  photoUrl: "",
  rating: 4.9,
  helpedCount: 34,
  etaSeconds: 480,
};

/**
 * A scripted stand-in for {@link RealNeedyClient} that walks the entire task lifecycle
 * (§3 Stages 1–7) on timers. It exists so every stage's animation can be reviewed and
 * tested — including against the real event *shapes* — without a running backend, mirroring
 * how the Phase 2 vocabulary was tuned in isolation before wiring to data.
 */
export class MockNeedyClient implements NeedyDriver {
  private readonly userId: string;
  private state: TaskExperienceState;
  private readonly listeners = new Set<() => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private taskId = "mock-task";
  private readonly speed: number;

  constructor(opts: { speed?: number; userId?: string } = {}) {
    this.speed = opts.speed ?? 1;
    this.userId = opts.userId ?? DEFAULT_USER_ID;
    this.state = { ...initialTaskState(this.userId), connection: "online" };
  }

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
  private at(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms / this.speed));
  }

  start(taskId: string): void {
    this.taskId = taskId;
    this.patch({ task: this.makeTask("searching") });
  }

  private makeTask(state: Task["state"], helperId: string | null = null): Task {
    // Built through the shared factory so a field added to `Task` cannot be silently missed
    // here — this driver scripts the whole lifecycle for the demo, and a missing field shows
    // up as `undefined` in a UI that looks otherwise fine.
    return makeTask({
      id: this.taskId,
      requesterId: this.userId,
      helperId,
      category: "errand",
      state,
      origin: ORIGIN,
      title: "Pick up medicine from the pharmacy",
      description: "test",
      price: 100,
      serviceCode: "groceries",
    });
  }

  /** Kick off the scripted lifecycle. Called by the demo when the requester asks for help. */
  requestHelp(): void {
    this.clearTimers();
    this.patch({
      ...initialTaskState(this.userId),
      connection: "online",
      task: this.makeTask("searching"),
    });

    // Stage 1 — helpers surface one by one. These are REAL coordinates around the origin now,
    // not normalized radar offsets: the server's `helpers-nearby` sends coarsened lat/lng, and
    // the mock exists to exercise the real event *shapes*. Feeding it fake unit offsets is what
    // let SearchingStage's broken coordinate fold survive review — everything looked fine in
    // the demo and collapsed to the radar centre against the live backend.
    this.at(700, () => this.addHelperAt(-0.35, 0.55));
    this.at(1600, () => this.addHelperAt(0.2, -0.5));
    this.at(2500, () => this.addHelperAt(0.6, 0.15));

    // Stage 2 — matched.
    this.at(3600, () =>
      this.patch({
        task: this.makeTask("matched", HELPER.id),
        helper: HELPER,
        presence: { userId: HELPER.id, state: "online-available", activity: "just-finished-nearby", lastActiveAt: 0 },
      }),
    );

    // Stage 3 — video verification.
    this.at(6200, () => this.patch({ task: this.makeTask("verifying", HELPER.id) }));

    // Stage 4 — en route: presence + moving location + ETA ticking down (fires milestones).
    this.at(9200, () => {
      this.patch({
        task: this.makeTask("en-route", HELPER.id),
        presence: { userId: HELPER.id, state: "online-busy", activity: "heading-to-task", lastActiveAt: 0 },
      });
      this.driveApproach();
    });
  }

  /** Emit a stream of location + ETA updates from ~1km out down to arrival. Delays are
   *  relative to when this is called, so it behaves the same whether driven by the scripted
   *  timeline or a manual advanceTo("en-route"). */
  private driveApproach(): void {
    const steps = 6;
    const startEta = 540;
    for (let i = 1; i <= steps; i++) {
      this.at(i * 1300, () => {
        const frac = i / steps;
        // Move from a point ~northeast of origin toward it.
        const lat = ORIGIN.lat + (1 - frac) * 0.009;
        const lng = ORIGIN.lng + (1 - frac) * 0.009;
        const etaSeconds = Math.max(20, Math.round(startEta * (1 - frac)));
        const milestone = nextMilestone(this.state.eta?.etaSeconds ?? null, etaSeconds, HELPER);
        this.patch({
          location: { lat, lng, heading: 225, speedMps: 2.4, at: 0 },
          eta: { etaSeconds, distanceMeters: Math.round((1 - frac) * 1200) },
          milestones: milestone ? [...this.state.milestones, milestone] : this.state.milestones,
        });
        if (i === steps) this.onArrived();
      });
    }
  }

  private onArrived(): void {
    // Stage 5 — arrival.
    this.patch({ task: this.makeTask("arrived", HELPER.id) });
    // Stage 6 — in-task: a greeting message, with a typing indicator first.
    this.at(2600, () => {
      this.patch({ task: this.makeTask("in-progress", HELPER.id), otherTyping: true });
      this.at(1600, () => {
        this.pushMessage(HELPER.id, "Hi! I'm at your gate with the medicine 🙂");
        this.patch({ otherTyping: false });
      });
    });
  }

  /** Surface a helper at a position expressed as a fraction of {@link MOCK_SPREAD_DEG} north
   *  and east of the origin, then converted to a real lat/lng — the shape the server actually
   *  sends. `northFrac`/`eastFrac` are in [-1, 1]. */
  private addHelperAt(northFrac: number, eastFrac: number): void {
    const lat = ORIGIN.lat + northFrac * MOCK_SPREAD_DEG;
    // Longitude degrees shrink with latitude, so widen the east offset to keep the visual
    // spread roughly circular rather than squashed.
    const lng =
      ORIGIN.lng +
      (eastFrac * MOCK_SPREAD_DEG) / Math.max(0.2, Math.cos((ORIGIN.lat * Math.PI) / 180));
    const points = [...this.state.helpersNearby.approxPoints, { lat, lng }];
    this.patch({ helpersNearby: { count: points.length, approxPoints: points } });
  }

  private pushMessage(senderId: string, body: string): void {
    const msg: ChatMessage = {
      id: `m-${this.state.messages.length}-${body.length}`,
      taskId: this.taskId,
      senderId,
      body,
      createdAt: 0,
      status: senderId === this.userId ? "sent" : "read",
    };
    this.patch({ messages: [...this.state.messages, msg] });
  }

  // ── requester actions ──────────────────────────────────────────────────────
  sendMessage(body: string): void {
    if (body.trim().length === 0) return;
    this.pushMessage(this.userId, body.trim());
    // Scripted reply so chat feels two-way.
    this.at(1200, () => this.patch({ otherTyping: true }));
    this.at(2600, () => {
      this.pushMessage(HELPER.id, "Got it — on my way up now.");
      this.patch({ otherTyping: false });
    });
  }
  /** Mirror the backend's guarded transition: only advance if the state machine allows it,
   *  and kick off the approach stream when entering `en-route` so tracking comes alive. */
  advanceTo(to: TaskState): void {
    const current = this.state.task?.state;
    if (!current || !canTransition(current, to) || to === "matched" || to === "searching") return;
    const helperId = this.state.task?.helperId ?? null;
    this.patch({ task: this.makeTask(to, helperId) });
    if (to === "en-route" && this.state.location == null) this.driveApproach();
  }

  setTyping(): void {
    /* no-op in the mock; the real client relays this to the helper */
  }
  markRead(messageIds: string[]): void {
    this.patch({
      messages: this.state.messages.map((m) =>
        messageIds.includes(m.id) ? { ...m, status: "read" } : m,
      ),
    });
  }

  // ── SOS ────────────────────────────────────────────────────────────────────
  /**
   * Simulate the server accepting a durable alert, including its LATENCY.
   *
   * The delay is deliberate rather than resolving synchronously. The whole reason the real
   * button was dangerous is that a local flag flipped instantly and the UI read as "help is
   * coming" with nothing behind it; if the mock resolved instantly too, the "sending…" state
   * would never be visible in the demo and the one piece of UI that has to prove it waits for
   * the server would go permanently untested. A scripted driver's job is to exercise the real
   * event *shapes and timings*, not to make the happy path look fast.
   */
  raiseSos(kind: SosKind, note?: string): Promise<SosAlert | null> {
    const task = this.state.task;
    if (!task) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.at(600, () => {
        const now = Date.now();
        const alert: SosAlert = {
          id: `mock-sos-${now}`,
          taskId: task.id,
          raisedBy: this.userId,
          kind,
          status: "raised",
          at: task.origin,
          note: note ?? null,
          createdAt: now,
          updatedAt: now,
        };
        this.patch({ sos: alert, lastError: null });
        resolve(alert);
      });
    });
  }

  cancelSos(alertId: string): Promise<boolean> {
    const current = this.state.sos;
    if (!current || current.id !== alertId) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.at(400, () => {
        // Status flips to `cancelled`; the record is NOT dropped, mirroring the server's rule
        // that a stood-down alarm is still an auditable event.
        this.patch({ sos: { ...current, status: "cancelled", updatedAt: Date.now() } });
        resolve(true);
      });
    });
  }

  /** Demo-only: jump straight to the warm close (§3 Stage 7). */
  complete(): void {
    this.patch({ task: this.makeTask("completed", HELPER.id) });
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
  dispose(): void {
    this.clearTimers();
    this.listeners.clear();
  }
}
