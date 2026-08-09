/** ── Auth + onboarding client ──────────────────────────────────────────────
 *  Talks to the backend's auth router. Every call sends `credentials: "include"`, because
 *  the real authentication path is httpOnly cookies — the access/refresh tokens are
 *  deliberately NOT readable from JS, so there is nothing to put in an Authorization header
 *  and nothing an XSS payload can exfiltrate.
 *
 *  Ported from the Vite app and extended with the onboarding pipeline (identity → documents
 *  → review). The uploads deliberately do NOT go through `call()`: they are multipart, and
 *  forcing a JSON content-type onto a FormData body breaks the boundary header.
 */

import { adoptCsrfToken, clearCsrfToken, csrfFetch } from "./csrf";

export type Role = "requester" | "helper" | "both" | "admin";
export type KycStatus = "unverified" | "pending" | "verified" | "rejected";

/** The onboarding pipeline. Distinct from `kycStatus`, which tracks the *provider* seam;
 *  this tracks how far the user has walked through our own manual review funnel. */
export type OnboardingStatus =
  | "draft" //             signed in, nothing submitted
  | "identity" //          phone verified, needs name/dob/gender
  | "documents" //         identity captured, needs ID + selfie + testimony
  | "under_review" //      everything submitted, waiting on a human
  | "approved" //          may transact
  | "rejected"; //         terminal. Phone is blocked; there is no way back.

export type Gender = "male" | "female" | "other";

export type DocumentKind = "gov_id" | "selfie" | "video_testimony";

export interface PublicUser {
  id: string;
  phone: string;
  email: string | null;
  displayName: string;
  role: Role;
  kycStatus: KycStatus;
  onboardingStatus: OnboardingStatus;
  dateOfBirth: string | null;
  gender: Gender | null;
  areaLabel: string | null;
  /** Coarse coordinates for `areaLabel`. Used to seed the request pin when the device has no
   *  fix; never a substitute for a live position. */
  areaLat: number | null;
  areaLng: number | null;
  /** Set only when `onboardingStatus === "rejected"` — shown on the terminal screen. */
  rejectionReason: string | null;
  /** Which of the three required documents the server has on file. Drives wizard resume. */
  documents: DocumentKind[];
}

/** A failed request carrying the server's machine-readable reason, so callers can branch
 *  (e.g. rate-limited vs wrong code) instead of pattern-matching on prose. */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /**
     * The refusal's full body, when the caller needs more than a code.
     *
     * Some refusals carry a number the user has to act on and cannot be told any other way.
     * The handoff is the case that forced this: a wrong code comes back with
     * `attemptsRemaining`, and five failures destroy the code — so a helper standing at a door
     * needs "two tries left", not a generic "that didn't work" followed by a code that
     * silently stops working. Dropping the body meant the server was computing that number and
     * throwing it away at the boundary.
     *
     * Optional and untyped on purpose: this is the raw shape of one endpoint's error, and
     * pretending otherwise would mean a union of every refusal in the app.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "AuthError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // Through `csrfFetch`, which attaches the token on mutating verbs and transparently
    // refreshes it once if the server says it is stale. Read-only calls pass straight through.
    res = await csrfFetch(path, {
      ...init,
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

/** Multipart POST. Note the absent content-type: the browser must set it itself so the
 *  multipart boundary is included, and overriding it produces a body the server cannot parse. */
async function upload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    // Also through `csrfFetch`. A header rides on a multipart body perfectly well — it is the
    // content-type that must be left to the browser, not the whole header set.
    res = await csrfFetch(path, { method: "POST", body: form });
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

export const authClient = {
  /** Send a one-time code. Deliberately returns nothing about whether the phone is known —
   *  a different response for registered vs unregistered numbers is an enumeration oracle. */
  requestOtp: (phone: string) =>
    call<{ ok: true }>("/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),

  verifyOtp: async (phone: string, code: string) => {
    const res = await call<{ user: PublicUser; csrfToken?: string }>("/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ phone, code }),
    });
    // The server rotates the token as part of establishing the session; adopting it here
    // means the first action after signing in does not have to fail once and retry.
    adoptCsrfToken(res.csrfToken);
    return res;
  },

  me: () => call<{ user: PublicUser }>("/auth/me"),

  /** Rotate the session. The refresh token is a cookie, so there is no argument to pass. */
  refresh: () => call<{ user: PublicUser }>("/auth/refresh", { method: "POST" }),

  logout: async () => {
    const res = await call<{ ok: true }>("/auth/logout", { method: "POST" });
    // The next session gets a new token; keeping this one cached would mean the first action
    // after signing back in fails once and silently retries for no reason.
    clearCsrfToken();
    return res;
  },

  // ── onboarding ────────────────────────────────────────────────────────────

  /** Step 2: name, email, date of birth, gender, home area. Age band and the eligibility
   *  matrix are both derived from `dateOfBirth`, so it cannot be edited after approval. */
  submitIdentity: (data: {
    displayName: string;
    email?: string;
    dateOfBirth: string;
    gender: Gender;
    areaLabel: string;
    areaLat?: number;
    areaLng?: number;
  }) =>
    call<{ user: PublicUser }>("/onboarding/identity", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  /** Steps 3–5. One endpoint for all three kinds; the server enforces which content types
   *  are acceptable per kind and re-sniffs the bytes rather than trusting the browser. */
  uploadDocument: (kind: DocumentKind, file: Blob, filename: string) => {
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file, filename);
    return upload<{ documents: DocumentKind[] }>("/onboarding/documents", form);
  },

  /** Final step: hand the packet to the review queue. Fails unless all three documents
   *  are present — the server re-checks rather than trusting the wizard's own state. */
  submitForReview: () =>
    call<{ user: PublicUser }>("/onboarding/submit", { method: "POST" }),
};
