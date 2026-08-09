/** ── Admin client ──────────────────────────────────────────────────────────
 *  Same cookie-credentialed transport as authClient. Kept in its own module because these
 *  endpoints all require the admin role, and mixing them into the client every page imports
 *  makes it harder to see at a glance what an ordinary user's bundle is allowed to call.
 */

import type { AbuseRollup, AbuseSignal, SosAlert } from "@needy/shared";
import { csrfFetch } from "./csrf";
import { AuthError, type DocumentKind, type Gender, type OnboardingStatus, type Role } from "./authClient";

export interface QueueEntry {
  id: string;
  displayName: string;
  /** Masked server-side. The queue is a list view, not a phone directory. */
  phoneMasked: string;
  onboardingStatus: OnboardingStatus;
  submittedAt: number | null;
  createdAt: number;
  role: Role;
  blockedAt: number | null;
}

export interface PacketUser {
  id: string;
  displayName: string;
  phone: string;
  email: string | null;
  dateOfBirth: string | null;
  gender: Gender | null;
  areaLabel: string | null;
  role: Role;
  onboardingStatus: OnboardingStatus;
  kycStatus: string;
  submittedAt: number | null;
  createdAt: number;
  reviewedBy: string | null;
  reviewedAt: number | null;
  rejectionReason: string | null;
  blockedAt: number | null;
}

export interface PacketDocument {
  kind: DocumentKind;
  label: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: number;
  /** Signed and short-lived — minted when the packet was opened, expires in ~2 minutes. */
  url: string;
  /** Other accounts that submitted byte-identical content. A duplicate-identity signal. */
  alsoSubmittedBy: string[];
}

/** An alert as the operator console reads it: the durable row plus the context needed to act
 *  without clicking through — who both parties are, and which of them pulled the alarm. */
export interface AlertView extends SosAlert {
  task: {
    id: string;
    title: string;
    state: string;
    category: string;
    origin: { lat: number; lng: number };
  } | null;
  requester: AlertParty | null;
  helper: AlertParty | null;
  raisedByRole: "requester" | "helper" | "unknown";
  /** Display names for the operators. The raw ids remain on `acknowledgedBy`/`resolvedBy`. */
  acknowledgedByName: string | null;
  resolvedByName: string | null;
}

export interface AlertParty {
  id: string;
  displayName: string;
  /** Full, not masked — an operator answering a live emergency is going to phone someone. */
  phone: string;
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  metadata: Record<string, unknown>;
  at: number;
}

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
    );
  }
  return body as T;
}

/** An operator, as the super admin's screen sees them. Never any password material — the hash
 *  is not on the user object at any layer, only the fact that one exists. */
export interface StaffMember {
  id: string;
  username: string | null;
  phone: string;
  displayName: string;
  role: Role;
  active: boolean;
  deactivatedAt: number | null;
  deactivatedReason: string | null;
  hasPassword: boolean;
  createdAt: number;
}

export const adminClient = {
  // ── staff administration (super admin only) ───────────────────────────────

  staff: () => call<{ staff: StaffMember[] }>("/admin/staff"),

  /** Create an operator. The NUMBER is assigned here and is not theirs to change — it is where
   *  their second factor will be sent, so letting them re-point it would hand the second factor
   *  to whoever holds the password. */
  createStaff: (body: {
    phone: string;
    displayName: string;
    password: string;
    username?: string;
  }) =>
    call<{ staff: StaffMember }>("/admin/staff", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deactivateStaff: (userId: string, reason: string) =>
    call<{ staff: StaffMember }>(`/admin/staff/${encodeURIComponent(userId)}/deactivate`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  activateStaff: (userId: string) =>
    call<{ staff: StaffMember }>(`/admin/staff/${encodeURIComponent(userId)}/activate`, {
      method: "POST",
    }),

  queue: (status: OnboardingStatus = "under_review") =>
    call<{ entries: QueueEntry[]; counts: Record<string, number> }>(
      `/admin/verifications?status=${encodeURIComponent(status)}`,
    ),

  packet: (userId: string) =>
    call<{ user: PacketUser; documents: PacketDocument[]; missing: DocumentKind[] }>(
      `/admin/verifications/${encodeURIComponent(userId)}`,
    ),

  decide: (userId: string, body: { decision: "approve" | "reject"; reason?: string; role?: Role }) =>
    call<{ user: PacketUser }>(
      `/admin/verifications/${encodeURIComponent(userId)}/decision`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  users: (q?: string) =>
    call<{ users: QueueEntry[] }>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),

  block: (userId: string, reason: string, blockPhone: boolean) =>
    call<{ user: PacketUser }>(`/admin/users/${encodeURIComponent(userId)}/block`, {
      method: "POST",
      body: JSON.stringify({ reason, blockPhone }),
    }),

  unblock: (userId: string) =>
    call<{ user: PacketUser }>(`/admin/users/${encodeURIComponent(userId)}/unblock`, {
      method: "POST",
    }),

  audit: (params: { subjectId?: string; actorId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.subjectId) q.set("subjectId", params.subjectId);
    if (params.actorId) q.set("actorId", params.actorId);
    q.set("limit", String(params.limit ?? 100));
    return call<{ entries: AuditRow[]; durable: boolean }>(`/admin/audit?${q}`);
  },

  // ── SOS ───────────────────────────────────────────────────────────────────

  sosQueue: (scope: "open" | "all" | "resolved" | "cancelled" = "open") =>
    call<{ alerts: AlertView[]; scope: string }>(
      `/admin/sos?scope=${encodeURIComponent(scope)}`,
    ),

  /** Takes ownership AND tells the raiser a person has their alarm. Deliberately a separate
   *  call from opening the queue — see the note on the route. */
  acknowledgeSos: (alertId: string) =>
    call<{ alert: AlertView }>(`/admin/sos/${encodeURIComponent(alertId)}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  resolveSos: (alertId: string, note: string) =>
    call<{ alert: AlertView }>(`/admin/sos/${encodeURIComponent(alertId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),

  // ── abuse ─────────────────────────────────────────────────────────────────

  abuseQueue: (windowMs?: number) =>
    call<{ entries: AbuseRollup[]; windowMs: number; since: number }>(
      `/admin/abuse${windowMs ? `?windowMs=${windowMs}` : ""}`,
    ),

  abuseSubject: (userId: string) =>
    call<{
      user: (PacketUser & { phone: string }) | null;
      signals: AbuseSignal[];
      windowMs: number;
    }>(`/admin/abuse/${encodeURIComponent(userId)}`),

  reviewAbuse: (userId: string, outcome: "no-action" | "warned" | "escalated", note: string) =>
    call<{ ok: true; outcome: string }>(`/admin/abuse/${encodeURIComponent(userId)}/review`, {
      method: "POST",
      body: JSON.stringify({ outcome, note }),
    }),

  /**
   * Fetch document bytes into an object URL.
   *
   * Deliberately NOT `<img src={signedUrl}>`. The raw route requires an admin session as well
   * as the signature, and a plain `<img>` gives no control over whether credentials are sent
   * — it depends on SameSite behaviour and the cross-origin rules for subresources, which
   * differ between a local `:3000 → :4000` setup and a production `web. → api.` one. An
   * explicit `credentials: "include"` fetch behaves identically in both.
   *
   * The caller MUST revokeObjectURL when done or every packet opened leaks its documents for
   * the lifetime of the tab.
   */
  fetchDocument: async (signedUrl: string): Promise<string> => {
    const res = await fetch(signedUrl, { credentials: "include" });
    if (!res.ok) throw new AuthError(res.status, `document-fetch-${res.status}`);
    return URL.createObjectURL(await res.blob());
  },
};
