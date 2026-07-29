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

export interface Task {
  id: string;
  requesterId: string;
  helperId: string | null;
  category: TaskCategory;
  state: TaskState;
  origin: LatLng;
  title: string;
  createdAt: number;
  updatedAt: number;
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
