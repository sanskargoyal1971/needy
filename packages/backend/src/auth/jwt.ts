import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { isRole, type KycStatus, type Role } from "./types.js";

/** Short-lived access token, reused for both REST and the socket handshake (§2.1). Carries
 *  role + KYC status so authorization checks don't need a DB round-trip on the hot path
 *  (they refresh whenever the access token rotates). */
export interface AuthClaims {
  sub: string; //           userId
  role: Role;
  displayName: string;
  kyc?: KycStatus;
}

export function signAccessToken(
  claims: AuthClaims,
  ttlSeconds = config.auth.accessTtlSeconds,
): string {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: ttlSeconds });
}

/** Returns claims or null. Never throws — callers decide how to reject. */
export function verifyAccessToken(token: string): AuthClaims | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (typeof decoded === "string") return null;
    const { sub, role, displayName, kyc } = decoded as jwt.JwtPayload & Partial<AuthClaims>;
    if (typeof sub !== "string" || !isRole(role)) return null;
    return {
      sub,
      role,
      displayName: displayName ?? "Someone",
      kyc: (kyc as KycStatus | undefined) ?? undefined,
    };
  } catch {
    return null;
  }
}
