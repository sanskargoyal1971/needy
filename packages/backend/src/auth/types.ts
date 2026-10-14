import type { Gender, OnboardingStatus } from "@needy/shared";

/** Roles are enforced at the API layer (not just the UI). "both" = a user who is both a
 *  requester and an active helper; "admin" gates the trust & safety surfaces (Stage B). */
/**
 * Who someone is on the platform.
 *
 * `super_admin` is the only role that can create staff. It sits above `admin` and is
 * deliberately NOT a participant role: a super admin holds no tasks, publishes no
 * availability and is never a matching candidate. It exists to administer the people who
 * administer the platform, and nothing else.
 */
export type Role = "requester" | "helper" | "both" | "admin" | "super_admin";
/**
 * The runtime list behind `isRole`, which every access token is verified against.
 *
 * The type-level check below fails compilation if `Role` gains a member that is missing here.
 * Without it, adding `super_admin` to the union left this array behind and every super-admin
 * token failed verification as a malformed claim — a 401 that looks like an expired session
 * and has nothing to do with expiry.
 */
export const ROLES = [
  "requester",
  "helper",
  "both",
  "admin",
  "super_admin",
] as const satisfies readonly Role[];
type RolesAreExhaustive = Role extends (typeof ROLES)[number] ? true : never;
const _rolesAreExhaustive: RolesAreExhaustive = true;
void _rolesAreExhaustive;
export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

/** KYC status drives what a helper is allowed to do. Helpers can't receive offers until
 *  `verified` (enforced in Stage C). We only ever persist status + masked provider refs. */
export type KycStatus = "unverified" | "pending" | "verified" | "rejected";

export interface User {
  id: string;
  phone: string;
  email: string | null;
  displayName: string;
  role: Role;
  kycStatus: KycStatus;
  createdAt: number;
  updatedAt: number;

  // ── onboarding / identity (migration 3) ────────────────────────────────────
  /** Manual-review funnel position. Distinct from `kycStatus`, which reflects the external
   *  provider seam; this is the gate that actually decides whether a user may transact. */
  onboardingStatus: OnboardingStatus;
  /** ISO `YYYY-MM-DD`. Stored as a date rather than an age because the eligibility matrix
   *  asks how old someone is *now*, and a stored age is wrong the day after it is written. */
  dateOfBirth: string | null;
  gender: Gender | null;
  /** Coarse home area — seeds the map. Never a live position; those live in Redis with a TTL. */
  areaLabel: string | null;
  areaLat: number | null;
  areaLng: number | null;
  /** Set with `onboardingStatus === "rejected"`; shown on the terminal hold screen. */
  rejectionReason: string | null;
  blockedAt: number | null;
  /** Admin who decided the packet, and when. */
  reviewedBy: string | null;
  reviewedAt: number | null;
  /** When the packet entered the queue — the queue's sort key. */
  submittedAt: number | null;

  // ── password credentials (migration 6) ────────────────────────────────────
  /**
   * When a password was last set, or null if this account has none.
   *
   * The FACT of a password, never the password. The hash lives in its own column behind
   * `UserRepository.getPasswordHash` and is deliberately absent from this type — see the note
   * there. This field is safe to serialise and is what the account screen reads to say "you
   * have a password" rather than guessing.
   */
  passwordSetAt: number | null;
  /** The admin who issued a temporary password, or null when the holder set their own. Makes
   *  a staff-set credential visible in the account itself, not only in the audit log. */
  passwordSetBy: string | null;

  /**
   * A name to sign in with, for staff. Null for everyone else.
   *
   * Identity on this platform is a verified phone number, and that is the right anchor for a
   * participant. A super admin is not a participant — they hold no tasks and are never a
   * matching candidate — so there is no number to verify and no SMS to wait on. Compared
   * case-insensitively; the unique index is on `lower(username)`.
   */
  username: string | null;

  // ── session epoch (migration 11) ──────────────────────────────────────────
  /**
   * Bumped whenever every session on the account is ended for cause — a second factor added
   * or removed, a password changed, a refresh token replayed. Each access token carries the
   * epoch it was minted under, and the staff guards refuse one that is behind.
   *
   * Revoking the refresh sessions alone is not enough: an access token is checked by
   * signature only, so a device that had just lost its session kept the console for the rest
   * of the token's lifetime (fifteen minutes by default). A counter rather than a timestamp so
   * that the token issued in the same millisecond as the bump is unambiguously on the new side.
   */
  sessionEpoch: number;
}

/**
 * Build a `User` from the few fields a caller actually cares about, defaulting the rest.
 *
 * Exists because migration 3 took `User` from 8 fields to 19, and without this every call
 * site — the login path plus a dozen test fixtures — would spell out eleven nulls. That is
 * not just verbose: it means the next field added has to be pasted into all of them, and the
 * one that gets missed becomes `undefined` at runtime while typechecking fine everywhere it
 * was remembered.
 *
 * The defaults are the *safe* ones. `onboardingStatus: "identity"` in particular: a user
 * built without an explicit status is un-onboarded and cannot transact, so a forgotten field
 * fails closed rather than granting access.
 */
export function makeUser(seed: Pick<User, "id" | "phone"> & Partial<User>): User {
  const now = seed.createdAt ?? 0;
  return {
    email: null,
    displayName: `User ${seed.phone.slice(-4)}`,
    role: "requester",
    kycStatus: "unverified",
    createdAt: now,
    updatedAt: now,
    onboardingStatus: "identity",
    dateOfBirth: null,
    gender: null,
    areaLabel: null,
    areaLat: null,
    areaLng: null,
    rejectionReason: null,
    blockedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    submittedAt: null,
    passwordSetAt: null,
    passwordSetBy: null,
    username: null,
    sessionEpoch: 0,
    ...seed,
  };
}

export interface Session {
  id: string;
  userId: string;
  /** SHA-256 of the opaque refresh token — never the token itself. */
  refreshTokenHash: string;
  userAgent: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}
