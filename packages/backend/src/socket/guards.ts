import type { Socket } from "socket.io";
import {
  isTerminal,
  taskRoleOf,
  type Task,
  type TaskRole,
} from "@needy/shared";
import type { Deps } from "../domain/deps.js";
import type { AuthClaims } from "../auth/jwt.js";
import { emitSocketError } from "./validation.js";

/** ── Task-participation guards (audit A3 / B9 / C18) ────────────────────────
 *  The original code checked participation in `chat.join` and `tracking.join` only.
 *  `chat.send`, `chat.typing` and `chat.mark-read` checked NOTHING — any holder of any
 *  valid JWT could inject a message into a stranger's private task, or flip read receipts
 *  on arbitrary global message ids. Rooms are not a security boundary: `nsp.to(room)`
 *  happily accepts a room you were never authorized to join, and `mark-read` never even
 *  consulted the room.
 *
 *  Authorization now lives in one place that every handler calls, so a new handler that
 *  forgets it is conspicuous rather than invisible.
 */

export interface Participation {
  task: Task;
  role: TaskRole;
}

/**
 * Resolve the caller's participation in `taskId`, or refuse.
 *
 * Returns null after emitting a typed error (and acking, if given) when the task is
 * missing or the caller is not a participant. NOT_FOUND and NOT_A_PARTICIPANT are
 * reported distinctly for the caller's own tasks only — for a task they have no part in,
 * a missing task and someone else's task are indistinguishable, which is deliberate:
 * otherwise this becomes an oracle for probing which task ids exist.
 */
export async function requireParticipant(
  deps: Deps,
  socket: Socket,
  event: string,
  userId: string,
  taskId: string,
  ack?: (result: { ok: false; error: string }) => void,
): Promise<Participation | null> {
  const task = await deps.tasks.get(taskId);
  const role = task ? taskRoleOf(task, userId) : null;

  if (!task || !role) {
    emitSocketError(socket, {
      event,
      code: "NOT_A_PARTICIPANT",
      message: "not a participant of this task",
      taskId,
    });
    ack?.({ ok: false, error: "not-a-participant" });
    return null;
  }
  return { task, role };
}

/** As `requireParticipant`, but additionally refuses once the task is terminal. Used for
 *  anything that mutates a live conversation or position: a completed/cancelled task must
 *  not keep accepting messages, locations or SOS alerts. */
export async function requireLiveParticipant(
  deps: Deps,
  socket: Socket,
  event: string,
  userId: string,
  taskId: string,
  ack?: (result: { ok: false; error: string }) => void,
): Promise<Participation | null> {
  const p = await requireParticipant(deps, socket, event, userId, taskId, ack);
  if (!p) return null;
  if (isTerminal(p.task.state)) {
    emitSocketError(socket, {
      event,
      code: "NOT_AUTHORIZED",
      message: `task is ${p.task.state}`,
      taskId,
    });
    ack?.({ ok: false, error: `task-${p.task.state}` });
    return null;
  }
  return p;
}

/** True if these claims may act as a helper at all. `both` covers users who do both.
 *  Read off the access token, which is short-lived — see the staleness note in
 *  auth/middleware for why a sensitive action re-checks against the database. */
export function claimsCanHelp(claims: AuthClaims): boolean {
  return claims.role === "helper" || claims.role === "both" || claims.role === "admin";
}

/** Helpers must be KYC-verified before they can be offered work or publish availability
 *  (audit B11 — previously assumed, never enforced). Admins bypass so support staff can
 *  operate without a personal eKYC record. */
export function claimsAreVerifiedHelper(claims: AuthClaims): boolean {
  if (claims.role === "admin") return true;
  return claimsCanHelp(claims) && claims.kyc === "verified";
}
