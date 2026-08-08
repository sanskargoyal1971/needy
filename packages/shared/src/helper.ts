/** ── Helper application & profile types ─────────────────────────────────────
 *  A user applies to become a helper by submitting this form. An admin manually
 *  reviews the application and approves or rejects it. On approval the user's
 *  role becomes "both" and their kycStatus becomes "verified". */

export type ApplicationStatus = "pending" | "approved" | "rejected";

/** The application record stored in `helper_applications`. Never deleted — a
 *  rejected application is historical evidence, not a row to recycle. */
export interface HelperApplication {
  id: string;
  userId: string;
  displayName: string;
  phone: string;
  /** Last 4 digits only — full Aadhaar is NEVER stored or logged (AGENTS.md). */
  aadhaarLast4: string;
  /** Free-text "why do you want to help" / experience description. */
  experience: string;
  status: ApplicationStatus;
  /** Admin userId who reviewed the application. Null while pending. */
  reviewedBy: string | null;
  /** Admin's note on the decision. */
  reviewNote: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Extended helper profile with earnings tracking. */
export interface HelperProfile {
  id: string;
  displayName: string;
  photoUrl: string;
  bio: string;
  rating: number;
  helpedCount: number;
  /** Lifetime earnings in whole rupees. */
  totalEarnings: number;
}
