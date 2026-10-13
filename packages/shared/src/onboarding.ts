/** ── Onboarding pipeline ───────────────────────────────────────────────────
 *  Nobody transacts on Needy until a human has looked at their government ID, their live
 *  selfie and their spoken video testimony. This module is the single definition of that
 *  funnel, imported by the backend (which enforces it) and the web app (which renders it),
 *  in the same spirit as `authz.ts`: one rule, not two that drift.
 *
 *  Deliberately separate from `kycStatus`. That field tracks the *provider* seam — what an
 *  external eKYC vendor said. This tracks our own manual review, which is the thing that
 *  actually gates access today. Collapsing them would mean a provider callback could move a
 *  user past a human review that never happened.
 */

/** Self-declared, and used by the eligibility matrix rather than for display. "other" exists
 *  because forcing a binary choice on a form people must complete to get help is both wrong
 *  and, for the matrix, unnecessary: only male/female pairings are ever restricted. */
export type Gender = "male" | "female" | "other";

export const GENDERS: readonly Gender[] = ["male", "female", "other"];

export function isGender(v: unknown): v is Gender {
  return typeof v === "string" && (GENDERS as readonly string[]).includes(v);
}

/**
 * How far a user has walked through the funnel.
 *
 * ```
 * draft ──phone+OTP──> identity ──name/dob/gender──> documents
 *   └─ gov ID → selfie → testimony ──submit──> under_review
 *                                                ├─approve→ approved
 *                                                └─reject──> rejected  (terminal)
 * ```
 */
export type OnboardingStatus =
  | "draft" //          account exists (phone verified), nothing submitted
  | "identity" //       needs name / email / date of birth / gender / area
  | "documents" //      identity captured, needs the three documents
  | "under_review" //   packet submitted, waiting on a human
  | "approved" //       may transact
  | "rejected"; //      terminal — see TERMINAL_ONBOARDING_STATES

export const ONBOARDING_STATUSES: readonly OnboardingStatus[] = [
  "draft",
  "identity",
  "documents",
  "under_review",
  "approved",
  "rejected",
];

export function isOnboardingStatus(v: unknown): v is OnboardingStatus {
  return typeof v === "string" && (ONBOARDING_STATUSES as readonly string[]).includes(v);
}

/**
 * States nothing moves out of.
 *
 * `rejected` is terminal *by product decision*, not by technical accident: a rejected user is
 * locked to the hold screen and their phone number is blocked, so re-registering is not a way
 * around the decision. Reinstating someone is therefore an explicit, audited admin action
 * against `phone_blocks` — deliberately not a state transition a user can trigger.
 */
export const TERMINAL_ONBOARDING_STATES: readonly OnboardingStatus[] = ["rejected"];

/** The three artefacts a human reviewer needs. All three are required — the review queue
 *  has no partial-packet state, because a reviewer looking at two of three cannot make the
 *  identity judgement the packet exists to support. */
export type DocumentKind = "gov_id" | "selfie" | "video_testimony";

export const REQUIRED_DOCUMENTS: readonly DocumentKind[] = ["gov_id", "selfie", "video_testimony"];

export function isDocumentKind(v: unknown): v is DocumentKind {
  return typeof v === "string" && (REQUIRED_DOCUMENTS as readonly string[]).includes(v);
}

/** What each document is, in the user's words. Rendered by the wizard and the admin queue
 *  from the same source so a reviewer is judging against the instruction actually given. */
export const DOCUMENT_LABELS: Record<DocumentKind, { title: string; instruction: string }> = {
  gov_id: {
    title: "Government photo ID",
    instruction:
      "Upload a clear photo of your Aadhaar, passport, driving licence or voter ID. All four corners must be visible and the text readable.",
  },
  selfie: {
    title: "Live selfie",
    instruction:
      "Take a photo right now using your camera, facing the light. This is matched against your ID — an uploaded existing photo will be rejected.",
  },
  video_testimony: {
    title: "Video introduction",
    instruction:
      "Record a short clip saying your full name and your occupation. This is what a reviewer watches to confirm you are a real, present person.",
  },
};

/**
 * Which MIME types are acceptable per document kind.
 *
 * Enforced server-side against the *sniffed* bytes, never the browser's declared
 * content-type — a client that says `image/jpeg` while sending a PHP script is the oldest
 * upload attack there is, and the declared type is attacker-controlled input.
 */
export const ACCEPTED_MIME: Record<DocumentKind, readonly string[]> = {
  gov_id: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  selfie: ["image/jpeg", "image/png", "image/webp"],
  video_testimony: ["video/mp4", "video/webm", "video/quicktime"],
};

/** Per-kind size ceilings in bytes. Video gets more room; an ID scan that needs 20 MB is a
 *  misconfigured camera, not a better scan. */
export const MAX_UPLOAD_BYTES: Record<DocumentKind, number> = {
  gov_id: 10 * 1024 * 1024,
  selfie: 8 * 1024 * 1024,
  video_testimony: 60 * 1024 * 1024,
};

/** Minimum age to hold an account at all. Below this the answer is no, not "needs review". */
export const MINIMUM_AGE_YEARS = 18;

/**
 * Which pane of the wizard the user still owes, given what they have actually supplied.
 *
 * The server derives this from stored facts rather than trusting a `step` the client sends,
 * which is what makes the wizard resumable on a new device and non-skippable from the console.
 *
 * The return type is deliberately narrow: only the two states a user can reach by *supplying
 * something*. `under_review` is NOT derivable, even once all three documents exist — it is the
 * act of pressing submit, and conflating the two is a real bug rather than a nicety:
 *
 *   - `submit` is idempotent on `under_review`, so if uploading the last file had already set
 *     that status, submit would short-circuit and never stamp `submittedAt` — leaving the
 *     review queue's sort key null for every applicant.
 *   - It would also mean a user who uploads a blurry selfie is queued for a reviewer before
 *     they have had the chance to look at it and retake it.
 *
 * `approved` and `rejected` are likewise decisions, never derivations. Callers hold them.
 * Use `readyToSubmit` to decide whether to enable the button.
 */
export function deriveOnboardingStatus(facts: {
  hasIdentity: boolean;
  documents: readonly DocumentKind[];
}): Extract<OnboardingStatus, "identity" | "documents"> {
  return facts.hasIdentity ? "documents" : "identity";
}

/** Everything the packet needs is present, so the user may hand it to a reviewer. */
export function readyToSubmit(facts: {
  hasIdentity: boolean;
  documents: readonly DocumentKind[];
}): boolean {
  const present = new Set(facts.documents);
  return facts.hasIdentity && REQUIRED_DOCUMENTS.every((d) => present.has(d));
}

/** Documents still outstanding — drives both the wizard's next pane and the "waiting on"
 *  column in the admin queue. */
export function missingDocuments(present: readonly DocumentKind[]): DocumentKind[] {
  const have = new Set(present);
  return REQUIRED_DOCUMENTS.filter((d) => !have.has(d));
}

/** May this user create tasks, accept offers, chat, or otherwise transact? Exactly one
 *  status qualifies. Written as an allowlist so a new status added later defaults to *no*. */
export function canTransact(status: OnboardingStatus): boolean {
  return status === "approved";
}

/** May this user see the app shell at all (read-only browsing while they wait)? Everyone
 *  except a rejected user, who is held on the terminal screen. */
export function canBrowse(status: OnboardingStatus): boolean {
  return status !== "rejected";
}
