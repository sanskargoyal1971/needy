import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { signAccessToken } from "./jwt.js";
import type { PhoneBlockRepository } from "./phoneBlocks.js";
import type { SessionRepository, UserRepository } from "./repos.js";
import { makeUser, type User } from "./types.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const defaultName = (phone: string) => `User ${phone.slice(-4)}`;

export interface AuthServiceDeps {
  users: UserRepository;
  sessions: SessionRepository;
  /** Consulted before find-or-create. A number rejected at review must not be able to open a
   *  fresh account, which is the whole reason rejection is a terminal state. */
  phoneBlocks: PhoneBlockRepository;
  now: () => number;
}

/** Thrown when a blocked number attempts to log in. A distinct type (not a null return) so
 *  the route can answer 403 rather than the generic 401 an unknown credential gets — the user
 *  is not mistaken about their code, they are refused. */
export class PhoneBlockedError extends Error {
  constructor() {
    super("phone-blocked");
    this.name = "PhoneBlockedError";
  }
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  user: User;
}

/**
 * Owns the credential lifecycle: find-or-create a user on first verified login, mint an
 * access JWT + an opaque refresh token, and rotate refresh tokens on every use (the old
 * session is revoked, so a stolen-then-reused refresh token can be detected as a hit on an
 * already-revoked session — a hook for reuse-detection lockout later).
 */
export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async loginWithPhone(phone: string, userAgent: string): Promise<IssuedTokens> {
    // Checked before the lookup, so a blocked number cannot be used to create an account and
    // cannot sign back into an existing one either. Both matter: rejection blocks the number,
    // and the rejected user's own account must stop working, not just new registrations.
    if (await this.deps.phoneBlocks.isBlocked(phone)) throw new PhoneBlockedError();

    let user = await this.deps.users.getByPhone(phone);
    if (!user) {
      const now = this.deps.now();
      user = await this.deps.users.create(
        makeUser({
          id: nanoid(),
          phone,
          displayName: defaultName(phone),
          createdAt: now,
          updatedAt: now,
          // A brand-new account starts at the front of the funnel, not at `draft`: the phone
          // is already verified by the OTP that got them here, so identity is what's owed next.
          onboardingStatus: "identity",
        }),
      );
    }
    return this.issue(user, userAgent);
  }

  async refresh(refreshToken: string, userAgent: string): Promise<IssuedTokens | null> {
    const now = this.deps.now();
    const session = await this.deps.sessions.getByHash(sha256(refreshToken));
    if (!session || session.revokedAt != null || session.expiresAt < now) return null;
    const user = await this.deps.users.getById(session.userId);
    if (!user) return null;
    await this.deps.sessions.revoke(session.id, now); // rotate
    return this.issue(user, userAgent);
  }

  async logout(refreshToken: string): Promise<void> {
    const session = await this.deps.sessions.getByHash(sha256(refreshToken));
    if (session) await this.deps.sessions.revoke(session.id, this.deps.now());
  }

  private async issue(user: User, userAgent: string): Promise<IssuedTokens> {
    const now = this.deps.now();
    const refreshToken = randomBytes(32).toString("hex");
    await this.deps.sessions.create({
      id: nanoid(),
      userId: user.id,
      refreshTokenHash: sha256(refreshToken),
      userAgent,
      createdAt: now,
      expiresAt: now + config.auth.refreshTtlDays * 86_400_000,
      revokedAt: null,
    });
    const accessToken = signAccessToken({
      sub: user.id,
      role: user.role,
      displayName: user.displayName,
      kyc: user.kycStatus,
    });
    return { accessToken, refreshToken, user };
  }
}
