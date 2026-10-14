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
  /** The account's `sessionEpoch` when this token was minted. Absent on tokens from before
   *  the field existed, which read as 0 — the epoch every account started at. */
  epoch?: number;
}

/** Pinned on both sides. `jsonwebtoken` would otherwise accept any HMAC variant the token's
 *  own header names; the verifier should not take its algorithm from the thing it verifies. */
const ALGORITHM = "HS256" as const;

export function signAccessToken(
  claims: AuthClaims,
  ttlSeconds = config.auth.accessTtlSeconds,
): string {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: ttlSeconds, algorithm: ALGORITHM });
}

/** Verify against the current key, then the previous one if a rotation is in progress. Tokens
 *  are only ever SIGNED with the current key, so the previous key ages out within one access
 *  token lifetime and can then be removed. */
function verifyWithKnownKeys(token: string): string | jwt.JwtPayload | null {
  const keys = [config.jwtSecret, config.jwtSecretPrevious].filter(Boolean);
  for (const key of keys) {
    try {
      return jwt.verify(token, key, { algorithms: [ALGORITHM] });
    } catch {
      // try the next key
    }
  }
  return null;
}

export function verifyAccessToken(token: string): AuthClaims | null {
  try {
    const decoded = verifyWithKnownKeys(token);
    if (decoded === null || typeof decoded === "string") return null;
    const { sub, role, displayName, kyc, epoch } = decoded as jwt.JwtPayload & Partial<AuthClaims>;
    if (typeof sub !== "string" || !isRole(role)) return null;
    return {
      sub,
      role,
      displayName: displayName ?? "Someone",
      kyc: (kyc as KycStatus | undefined) ?? undefined,
      epoch: Number.isInteger(epoch) ? epoch : 0,
    };
  } catch {
    return null;
  }
}
