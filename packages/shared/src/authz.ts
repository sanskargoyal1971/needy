import type { TaskState } from "./task.js";

/** ── Authorization matrix (audit B12 / C18) ────────────────────────────────
 *  Participation alone is NOT sufficient to drive a task's lifecycle. Before this
 *  existed, any participant could unilaterally advance any legal edge — a requester
 *  could mark a task `arrived` and `in-progress` without the helper ever moving.
 *
 *  Both sides import this table: the backend enforces it inside `advance-task`, and
 *  the frontend uses it to only offer controls the caller may actually use. Keeping it
 *  in `shared` is what makes "the UI hid the button" and "the server refused" the same
 *  rule rather than two rules that drift.
 */

/** A caller's role *relative to the task in hand* — distinct from their account role.
 *  The same user is `requester` on tasks they opened and `helper` on tasks they accepted. */
export type TaskRole = "requester" | "helper";

/**
 * Which task-role may drive a task INTO each state.
 *
 * Rationale for each edge:
 * - `verifying`   — either party may open the verification call; both have an interest
 *                   in confirming identity before they meet.
 * - `en-route`    — physical-progress claims belong to the person moving. Only the
 *                   helper can assert they have set off.
 * - `arrived`     — likewise: only the helper can claim to be at the door.
 * - `in-progress` — the helper starts the work.
 * - `completed`   — the REQUESTER confirms. A helper must not be able to close a task
 *                   (and with it the tracked, chattable, SOS-capable window) on their
 *                   own say-so; that is the one edge where the vulnerable party holds
 *                   the switch. See the note below on two-sided completion.
 * - `cancelled`   — either party may withdraw at any point.
 * - `searching` / `matched` — never a free-form advance. `searching` is set at creation
 *                   and `matched` exclusively by the accept flow under its distributed
 *                   lock, so no actor appears here at all.
 */
export const TRANSITION_ACTORS: Record<TaskState, readonly TaskRole[]> = {
  searching: [],
  matched: [],
  verifying: ["requester", "helper"],
  "en-route": ["helper"],
  arrived: ["helper"],
  "in-progress": ["helper"],
  completed: ["requester"],
  cancelled: ["requester", "helper"],
};

/** True if `role` is permitted to drive a task into `to`. Pair with `canTransition`
 *  (which checks the edge is legal at all) — both must pass. */
export function canActorTransition(role: TaskRole, to: TaskState): boolean {
  return TRANSITION_ACTORS[to].includes(role);
}

/** The task-role a user holds on a task, or null if they are not a participant. Used by
 *  both the backend guard and the frontend control gating so "am I allowed" is computed
 *  from one function. */
export function taskRoleOf(
  task: { requesterId: string; helperId: string | null },
  userId: string,
): TaskRole | null {
  if (task.requesterId === userId) return "requester";
  if (task.helperId != null && task.helperId === userId) return "helper";
  return null;
}

/**
 * KNOWN GAP — two-sided completion. `completed` is requester-driven here, which means a
 * helper who finishes work for a requester unable to confirm (asleep, phone dead, a
 * genuine emergency) cannot close the task themselves. The real design is a two-sided
 * confirm with a support-mediated timeout escape hatch; that needs a `completion_requests`
 * table and an operator surface, so it is deliberately out of scope for this pass rather
 * than half-built. Until then a stuck task is resolved by `cancelled`, which either party
 * may set, so nobody is trapped in a live tracking session.
 */
export const COMPLETION_IS_TWO_SIDED = false;
