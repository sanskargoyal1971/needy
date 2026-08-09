/** ── Participant API client ────────────────────────────────────────────────
 *  Everything a requester or helper does over REST, as opposed to over a socket.
 *
 *  The split is not arbitrary. The socket carries what is *live* — offers, positions, chat,
 *  the alarm — and REST carries what must be durable and idempotent before anything live can
 *  begin: creating a task, issuing a one-time code, uploading a video. A dropped socket frame
 *  costs a redraw; a dropped task creation costs a person their request, so those go over a
 *  transport with a status code.
 *
 *  Kept separate from `authClient` (identity) and `adminClient` (staff) for the same reason
 *  those are separate from each other: it should be legible at a glance which endpoints an
 *  ordinary user's bundle is allowed to call.
 */

import type {
  ServiceDefinition,
  SessionSnapshot,
  Task,
  TaskCategory,
} from "@needy/shared";
import { AuthError } from "./authClient";
import { csrfFetch } from "./csrf";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await csrfFetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new AuthError(0, "network-unreachable", "cannot reach the server");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new AuthError(
      res.status,
      typeof body.error === "string" ? body.error : `http-${res.status}`,
      typeof body.reason === "string" ? body.reason : undefined,
      // Carried through, not discarded — see the note on `AuthError.details`. The handoff's
      // `attemptsRemaining` is the case that needs it.
      body,
    );
  }
  return body as T;
}

// ── task creation ───────────────────────────────────────────────────────────

export interface CreateTaskInput {
  category: TaskCategory;
  origin: { lat: number; lng: number };
  title: string;
  description: string;
  serviceCode?: string;
  /** Epoch ms. Only for an exception-gated booking, which needs a day's lead time. */
  scheduledFor?: number;
  /** Naming a specific helper is what makes a booking a restricted-pairing booking. */
  helperId?: string;
}

/** The server's refusals on `POST /tasks`, as machine-readable codes.
 *
 *  These are the ones the UI must actually branch on rather than show as "something went
 *  wrong": each of them is a decision the person can respond to, and two of them are the
 *  eligibility matrix speaking — which is a refusal a real person will find upsetting and
 *  deserves an explanation rather than an error toast. */
export type CreateTaskRefusal =
  | "pairing-denied"
  | "exception-required"
  | "schedule-required"
  | "invalid-schedule"
  | "helper-not-found"
  | "too-many-requests";

export interface HandoffView {
  taskId: string;
  state: Task["state"];
  serviceBrief: string | null;
  briefSubmitted: boolean;
  handoffVerifiedAt: number | null;
  /** Requester only — the helper's UI shows an entry box instead. */
  codeIssued?: boolean;
}

export interface ExceptionView {
  id: string;
  requesterId: string;
  helperId: string;
  status: "awaiting_videos" | "under_review" | "approved" | "rejected" | "expired";
  requesterVideoSubmitted: boolean;
  helperVideoSubmitted: boolean;
  createdAt: number;
  submittedAt: number | null;
  decidedAt: number | null;
  expiresAt: number | null;
  reviewNote: string | null;
  /** So the UI can say "by tomorrow evening" rather than "soon". */
  reviewDueBy: number | null;
}

/** An exception as either party sees it, with the caller's own side resolved server-side so
 *  no client has to compare ids to work out whose testimony is outstanding. */
export interface ParticipantException extends ExceptionView {
  myRole: "requester" | "helper";
  /** The other party's display name — and nothing else about them. A pairing under review is
   *  exactly the case where the two are not yet cleared to know more about each other. */
  otherName: string;
}

export const taskClient = {
  // ── tasks ─────────────────────────────────────────────────────────────────

  /** Create a request. Returns the durable task; the search itself is then opened over the
   *  socket with `requestHelp()`, because that is the live part. */
  create: (input: CreateTaskInput) =>
    call<Task>("/tasks", { method: "POST", body: JSON.stringify(input) }),

  get: (taskId: string) =>
    call<{ task: Task }>(`/tasks/${encodeURIComponent(taskId)}`),

  /**
   * Every task this user is currently party to, with its live context.
   *
   * The same endpoint the drivers re-sync from after a drop, used here for a different job:
   * answering "do I already have something running" on first load. It is the right source
   * precisely because it is server-authoritative — a home screen that decided from local
   * state whether a task was live would be wrong for the person who closed the tab mid-task,
   * which is the one person who most needs it to be right.
   */
  snapshot: () => call<SessionSnapshot>("/snapshot"),

  /** Completed and cancelled tasks, newest first. Returns an empty list against an
   *  in-memory backend, which is honest rather than an error — there is no history to have. */
  history: () => call<{ tasks: Task[] }>("/tasks/history"),

  // ── the doorstep handoff ──────────────────────────────────────────────────

  handoff: (taskId: string) =>
    call<HandoffView>(`/tasks/${encodeURIComponent(taskId)}/handoff`),

  /** Helper: what I will and will not do. A precondition for a code being issued. */
  submitBrief: (taskId: string, brief: string) =>
    call<HandoffView>(`/tasks/${encodeURIComponent(taskId)}/handoff/brief`, {
      method: "POST",
      body: JSON.stringify({ brief }),
    }),

  /**
   * Requester: reveal the one-time code.
   *
   * The ONLY time the plaintext exists outside the server's hash, and it is shown to the
   * requester alone — they read it aloud to the person in front of them, which is what makes
   * entering it evidence of presence rather than evidence of having a phone. Re-issuing
   * replaces the previous hash, so a code read out earlier stops working immediately.
   */
  revealCode: (taskId: string) =>
    call<{ code: string; expiresAt: number }>(
      `/tasks/${encodeURIComponent(taskId)}/handoff/code`,
      { method: "POST" },
    ),

  /** Helper: enter what the requester read out. Five wrong guesses burn the code. */
  verifyCode: (taskId: string, code: string) =>
    call<HandoffView>(`/tasks/${encodeURIComponent(taskId)}/handoff/verify`, {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  // ── service catalog ───────────────────────────────────────────────────────

  services: () => call<{ services: ServiceDefinition[] }>("/services"),

  myServices: () => call<{ codes: string[]; mandatory: string[] }>("/me/services"),

  setMyServices: (codes: string[]) =>
    call<{ codes: string[]; mandatory: string[] }>("/me/services", {
      method: "PUT",
      body: JSON.stringify({ codes }),
    }),

  // ── exceptions ────────────────────────────────────────────────────────────

  /** Where does my request to be paired with this specific helper stand? Null means none has
   *  ever been opened, which is different from one having been refused. */
  /**
   * Every live exception I am a party to, on either side.
   *
   * The helper's only way in. They did not open the request, so they hold no id, and
   * `exceptionFor` is keyed on the pair from the requester's side — this is what lets the
   * second person be told that a testimony is waiting on them.
   */
  myExceptions: () =>
    call<{ exceptions: ParticipantException[] }>("/me/exceptions"),

  exceptionFor: (helperId: string) =>
    call<{ exception: ExceptionView | null }>(
      `/exceptions/for/${encodeURIComponent(helperId)}`,
    ),

  openException: (helperId: string) =>
    call<{ exception: ExceptionView }>("/exceptions", {
      method: "POST",
      body: JSON.stringify({ helperId }),
    }),

  /** Upload one party's spoken testimony. Multipart, so it does not go through `call` — a
   *  JSON content-type on a FormData body strips the boundary the server parses on. */
  uploadExceptionVideo: async (exceptionId: string, video: Blob, filename: string) => {
    const form = new FormData();
    form.append("file", video, filename);
    let res: Response;
    try {
      res = await csrfFetch(`/exceptions/${encodeURIComponent(exceptionId)}/video`, {
        method: "POST",
        body: form,
      });
    } catch {
      throw new AuthError(0, "network-unreachable", "cannot reach the server");
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new AuthError(
        res.status,
        typeof body.error === "string" ? body.error : `http-${res.status}`,
      );
    }
    return body as { exception: ExceptionView };
  },
};
