/** ── Auth client ───────────────────────────────────────────────────────────
 *  Talks to the Stage A endpoints in the backend's auth router. Every call sends
 *  `credentials: "include"`, because the real authentication path is httpOnly cookies —
 *  the access/refresh tokens are deliberately NOT readable from JS, so there is nothing to
 *  put in an Authorization header and nothing an XSS payload can exfiltrate.
 *
 *  (The audit found `fetchSnapshot` omitting `credentials`, which is why cookie auth had
 *  never actually been exercised from the UI: every request arrived anonymous and the app
 *  leaned on the dev-token bypass instead.)
 */

export type Role = "requester" | "helper" | "both" | "admin";
export type KycStatus = "unverified" | "pending" | "verified" | "rejected";

export interface PublicUser {
  id: string;
  phone: string;
  email: string | null;
  displayName: string;
  role: Role;
  kycStatus: KycStatus;
}

import { API_BASE as API } from "../apiConfig.js";

/** A failed request carrying the server's machine-readable reason, so callers can branch
 *  (e.g. rate-limited vs wrong code) instead of pattern-matching on prose. */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AuthError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    // A network-level failure is not the same as a rejection by the server, and the UI
    // should say so rather than implying the user did something wrong.
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

export const authClient = {
  /** Send a one-time code. Deliberately returns nothing about whether the phone is known —
   *  a different response for registered vs unregistered numbers is an enumeration oracle. */
  requestOtp: (phone: string) =>
    call<{ ok: true }>("/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),

  verifyOtp: (phone: string, code: string) =>
    call<{ user: PublicUser }>("/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ phone, code }),
    }),

  me: () => call<{ user: PublicUser }>("/auth/me"),

  /** Rotate the session. The refresh token is a cookie, so there is no argument to pass. */
  refresh: () => call<{ user: PublicUser }>("/auth/refresh", { method: "POST" }),

  logout: () => call<{ ok: true }>("/auth/logout", { method: "POST" }),

  updateMe: (patch: { displayName?: string; email?: string; role?: Role }) =>
    call<{ user: PublicUser }>("/auth/me", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  startKyc: () => call<{ verificationUrl: string }>("/auth/kyc/start", { method: "POST" }),

  kycStatus: () => call<{ kycStatus: KycStatus }>("/auth/kyc/status"),

  // ── Helper Applications ───────────────────────────────────────────────────
  applyAsHelper: (data: { displayName: string; phone: string; aadhaarLast4: string; experience: string }) =>
    call<{ application: any }>("/helpers/apply", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getApplications: () => call<{ applications: any[] }>("/admin/applications"),

  reviewApplication: (id: string, decision: "approved" | "rejected", note?: string) =>
    call<{ application: any }>("/admin/applications/" + id + "/review", {
      method: "POST",
      body: JSON.stringify({ decision, note }),
    }),

  getTaskHistory: (page?: number) => call<{ tasks: any[]; total: number }>("/tasks/history" + (page ? `?page=${page}` : "")),

  getEarnings: () => call<{ earnings: number }>("/helpers/me/earnings"),

  getAdminStats: () => call<{ users: number; helpers: number; tasks: number; revenue: number }>("/admin/stats"),

  getAdminUsers: (page?: number) => call<{ users: any[]; total: number }>("/admin/users" + (page ? `?page=${page}` : "")),
};
