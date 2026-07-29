import { canTransition } from "@needy/shared";
import type { ChatMessage, LatLng, MatchedHelper, Task, TaskState } from "@needy/shared";
import {
  initialTaskState,
  type NeedyDriver,
  type TaskExperienceState,
} from "./types.js";
import { nextMilestone } from "./milestones.js";

const ORIGIN: LatLng = { lat: 12.9716, lng: 77.5946 };
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
  private state: TaskExperienceState = { ...initialTaskState(), connection: "online" };
  private readonly listeners = new Set<() => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private taskId = "mock-task";
  private readonly speed: number;

  constructor(opts: { speed?: number; userId?: string } = {}) {
    this.speed = opts.speed ?? 1;
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
    return {
      id: this.taskId,
      requesterId: "me",
      helperId,
      category: "errand",
      state,
      origin: ORIGIN,
      title: "Pick up medicine from the pharmacy",
      createdAt: 0,
      updatedAt: 0,
    };
  }

  /** Kick off the scripted lifecycle. Called by the demo when the requester asks for help. */
  requestHelp(): void {
    this.clearTimers();
    this.patch({
      ...initialTaskState(),
      connection: "online",
      task: this.makeTask("searching"),
    });

    // Stage 1 — helpers surface one by one.
    this.at(700, () => this.addHelper(0.55, -0.35));
    this.at(1600, () => this.addHelper(-0.5, 0.2));
    this.at(2500, () => this.addHelper(0.15, 0.6));

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

  private addHelper(x: number, y: number): void {
    const points = [...this.state.helpersNearby.approxPoints, { lat: x, lng: y }];
    this.patch({ helpersNearby: { count: points.length, approxPoints: points } });
  }

  private pushMessage(senderId: string, body: string): void {
    const msg: ChatMessage = {
      id: `m-${this.state.messages.length}-${body.length}`,
      taskId: this.taskId,
      senderId,
      body,
      createdAt: 0,
      status: senderId === "me" ? "sent" : "read",
    };
    this.patch({ messages: [...this.state.messages, msg] });
  }

  // ── requester actions ──────────────────────────────────────────────────────
  sendMessage(body: string): void {
    if (body.trim().length === 0) return;
    this.pushMessage("me", body.trim());
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
