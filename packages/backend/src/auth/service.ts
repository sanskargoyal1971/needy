import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { signAccessToken } from "./jwt.js";
import type { PhoneBlockRepository } from "./phoneBlocks.js";
import type { SessionRepository, UserRepository } from "./repos.js";
import { burnVerification, hashPassword, verifyPassword } from "./password.js";
import { makeUser, type User } from "./types.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** How long after a rotation a second presentation of the old refresh token is treated as a
 *  race between the user's own tabs rather than as theft. */
const REFRESH_REUSE_GRACE_MS = 10_000;
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

  /**
   * Sign in with a phone number and a password.
   *
   * Three properties this owes, all of which are about what a FAILURE reveals rather than what
   * a success does:
   *
   *  1. **One answer for every failure.** Unknown number, no password set, wrong password —
   *     all return `null`. Distinguishing them would turn this route into a directory of who
   *     holds an account, and on a platform whose users are selected for being vulnerable,
   *     confirming that a given number belongs to an elderly person living alone is itself the
   *     harm.
   *  2. **The same amount of time either way.** A real account costs ~100 ms of scrypt; an
   *     unknown one would cost nothing and answer instantly. `burnVerification` spends the
   *     same work on the miss, so the clock does not become the oracle that (1) closed.
   *  3. **Never creates an account.** `loginWithPhone` is find-or-create, because a verified
   *     OTP proves the number. A password proves nothing about a number nobody has claimed, so
   *     this path only ever authenticates an account that already exists.
   */
  async loginWithPassword(
    phone: string,
    password: string,
    userAgent: string,
  ): Promise<IssuedTokens | null> {
    if (await this.deps.phoneBlocks.isBlocked(phone)) throw new PhoneBlockedError();

    const user = await this.deps.users.getByPhone(phone);
    if (!user) {
      await burnVerification(password);
      return null;
    }
    const hash = await this.deps.users.getPasswordHash(user.id);
    if (!(await verifyPassword(password, hash))) return null;

    return this.issue(user, userAgent);
  }

  /**
   * Sign in with a username and a password — the staff door.
   *
   * Same three properties as the phone path: one answer for every failure, the same time
   * either way, and it never creates an account. The difference is only which column is
   * looked up, because a super admin is not a participant and has no verified number to be
   * keyed on.
   *
   * Refuses anyone whose role does not use a username, even if a username is somehow set on
   * their row. That is a second lock on the same door: the staff login must not become an
   * alternative way into an ordinary account that bypasses the phone.
   */
  async loginWithUsername(
    username: string,
    password: string,
    userAgent: string,
  ): Promise<IssuedTokens | null> {
    const user = await this.deps.users.getByUsername(username);
    // SUPER ADMIN ONLY. An ordinary admin has an assigned phone and signs in through it, so
    // that they always owe the second factor — if the username door accepted them it would be
    // a way to reach the console with one factor, which is exactly what the second factor is
    // there to prevent.
    if (!user || user.role !== "super_admin") {
      await burnVerification(password);
      return null;
    }
    // A deactivated account is refused here as everywhere else. Without this the staff door
    // would be the one entrance that ignored a block.
    if (user.blockedAt != null) return null;

    const hash = await this.deps.users.getPasswordHash(user.id);
    if (!(await verifyPassword(password, hash))) return null;

    return this.issue(user, userAgent);
  }

  /**
   * Issue a session for a user we have already authenticated by another means.
   *
   * Exists for the admin second factor: the password is checked, then a one-time code, and the
   * session is only minted once both have passed. Deliberately not exported as a general
   * "log this user in" — it takes a `User` the caller must already have proven.
   */
  async issueFor(user: User, userAgent: string): Promise<IssuedTokens> {
    return this.issue(user, userAgent);
  }

  /**
   * End every session the account has and issue one fresh one for the device asking.
   *
   * For a change to how the account is protected — adding or removing its second factor. A
   * session that existed before the change was obtained under the old rules, so it must not
   * carry over: without this, a session minted on a password alone outlives the authenticator
   * that was supposed to make that impossible. The caller's own device is re-issued so the
   * person making the change is not signed out of the browser they are holding, as
   * `/auth/me/password` does.
   */
  async replaceSessions(user: User, userAgent: string): Promise<IssuedTokens> {
    await this.deps.sessions.revokeAllForUser(user.id, this.deps.now());
    return this.issue(user, userAgent);
  }

  /**
   * Set or replace a password.
   *
   * Every existing session is revoked. That is the point of changing a password: the common
   * reason to do it is that someone else may have had it, and leaving their session alive
   * would make the change cosmetic. The caller's own session is re-issued by the route so the
   * person changing it is not signed out of the device they are holding.
   */
  async setPassword(
    userId: string,
    password: string,
    opts: { setBy?: string | null; revokeSessions?: boolean } = {},
  ): Promise<void> {
    const now = this.deps.now();
    const hash = await hashPassword(password);
    await this.deps.users.setPasswordHash(userId, hash, now, opts.setBy ?? null);
    if (opts.revokeSessions !== false) {
      await this.deps.sessions.revokeAllForUser(userId, now);
    }
  }

  /** Remove a password, leaving the account reachable by one-time code only. */
  async clearPassword(userId: string): Promise<void> {
    const now = this.deps.now();
    await this.deps.users.setPasswordHash(userId, null, now, null);
    await this.deps.sessions.revokeAllForUser(userId, now);
  }

  async refresh(refreshToken: string, userAgent: string): Promise<IssuedTokens | null> {
    const now = this.deps.now();
    const session = await this.deps.sessions.getByHash(sha256(refreshToken));
    if (!session) return null;

    if (session.revokedAt != null) {
      // A refresh token that was already rotated is being presented again. Either two tabs
      // raced (harmless, and recent) or a copy of the token is in someone else's hands. Past
      // a short grace window there is no innocent explanation, and the thief may be the one
      // holding the *current* token — so every session for the account ends and the real
      // owner signs in again.
      if (now - session.revokedAt > REFRESH_REUSE_GRACE_MS) {
        await this.deps.sessions.revokeAllForUser(session.userId, now);
      }
      return null;
    }
    if (session.expiresAt < now) return null;

    const user = await this.deps.users.getById(session.userId);
    // A blocked account does not get a new access token. Blocking already revokes sessions;
    // this is the same rule stated where the token is minted.
    if (!user || user.blockedAt != null) return null;

    // Rotate. Only the call that actually flips the row may issue — two concurrent refreshes
    // used to both read "not revoked" and both walk away with a live session.
    const rotated = await this.deps.sessions.revoke(session.id, now);
    if (!rotated) return null;
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
