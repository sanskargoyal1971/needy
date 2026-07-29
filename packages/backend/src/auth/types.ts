/** Roles are enforced at the API layer (not just the UI). "both" = a user who is both a
 *  requester and an active helper; "admin" gates the trust & safety surfaces (Stage B). */
export type Role = "requester" | "helper" | "both" | "admin";
export const ROLES: readonly Role[] = ["requester", "helper", "both", "admin"];
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
