import type { LatLng } from "./geo.js";

/** The task lifecycle. Each state is the anchor for one animated stage in §3, so the
 *  names here are the single source of truth the frontend switches its VFX on. */
export type TaskState =
  | "searching" //        Stage 1 — radar sweep, finding helpers
  | "matched" //          Stage 2 — the reveal moment
  | "verifying" //        Stage 3 — video verification call
  | "en-route" //         Stage 4 — live tracking
  | "arrived" //          Stage 5 — arrival moment
  | "in-progress" //      Stage 6 — in-task (chat / SOS)
  | "completed" //        Stage 7 — warm close
  | "cancelled";

/** Categories change matching weights: social-service tasks factor volunteer standing. */
export type TaskCategory = "errand" | "companionship" | "social-service" | "urgent";

/** Flat-rate pricing per category in whole rupees. Social-service is volunteer (free).
 *  These are the base prices shown to the requester; helpers earn HELPER_SHARE_PERCENT. */
export const CATEGORY_PRICING: Record<TaskCategory, number> = {
  errand: 149,
  companionship: 199,
  "social-service": 0,
  urgent: 299,
};

/** The fraction of the task price credited to the helper on completion. */
export const HELPER_SHARE_PERCENT = 80;

export interface Task {
  id: string;
  requesterId: string;
  helperId: string | null;
  category: TaskCategory;
  state: TaskState;
  origin: LatLng;
  title: string;
  /** Free-text description of what the requester needs help with. */
  description: string;
  /** Price in whole rupees, auto-set from CATEGORY_PRICING at creation. */
  price: number;

  /**
   * Which catalog service was requested (`services.code`).
   *
   * Nullable because rows created before the catalog existed have no code beyond what
   * migration 4's backfill inferred from `category`. Every task created since carries one,
   * and matching uses it to offer work only to helpers who actually provide that service.
   */
  serviceCode: string | null;

  /**
   * When the task should happen, or null to dispatch NOW.
   *
   * Null is the overwhelmingly common case: ordinary bookings are live, the way a
   * ride-hailing app is. A timestamp appears only on an exception-gated booking, where the
   * pairing needs a human to review two video testimonies first and the lead time is what
   * makes that review possible.
   */
  scheduledFor: number | null;

  createdAt: number;
  updatedAt: number;
}

/**
 * Build a `Task` from the fields a caller actually cares about, defaulting the rest.
 *
 * Same rationale as `makeUser` on the backend: this interface has grown twice now, and
 * without a factory every new field has to be pasted into a dozen fixtures — where the one
 * that gets missed is `undefined` at runtime while typechecking fine everywhere it was
 * remembered.
 *
 * Defaults are the ordinary case: no schedule (dispatch now) and no service code.
 */
export function makeTask(
  seed: Pick<Task, "id" | "requesterId" | "category" | "state" | "origin" | "title"> &
    Partial<Task>,
): Task {
  return {
    helperId: null,
    description: "",
    price: CATEGORY_PRICING[seed.category],
    serviceCode: null,
    scheduledFor: null,
    createdAt: 0,
    updatedAt: 0,
    ...seed,
  };
}

/** Terminal states never transition further; the reconnect snapshot uses this to decide
 *  whether to resubscribe a client to live event streams. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  "completed",
  "cancelled",
];

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/**
 * The task lifecycle state machine — the single source of truth both the backend (which
 * enforces it before broadcasting `task-updated`) and the frontend (which offers only legal
 * next steps) import. `searching → matched` is intentionally NOT advanceable here: that edge
 * is owned exclusively by the matching accept flow under its distributed lock, never by a
 * free-form state change.
 */
export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  searching: ["matched", "cancelled"],
  matched: ["verifying", "en-route", "cancelled"],
  verifying: ["en-route", "cancelled"],
  "en-route": ["arrived", "cancelled"],
  arrived: ["in-progress", "cancelled"],
  "in-progress": ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** States a participant may drive a task INTO via the `advance-task` action. Excludes
 *  `matched` and `searching`, which are never set by a free-form advance. */
export const ADVANCEABLE_STATES: readonly TaskState[] = [
  "verifying",
  "en-route",
  "arrived",
  "in-progress",
  "completed",
  "cancelled",
];

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** The legal next states a participant can advance to from `from` (drives the UI's controls). */
export function advanceableNextStates(from: TaskState): TaskState[] {
  return TASK_TRANSITIONS[from].filter((s) => ADVANCEABLE_STATES.includes(s));
}
