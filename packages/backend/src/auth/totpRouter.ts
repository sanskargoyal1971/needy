import { Router, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import type { AuditLogger } from "../audit/log.js";
import { keys } from "../domain/keys.js";
import { asyncRoute } from "../http/asyncRoute.js";
import { logger } from "../logger.js";
import type { RedisClient } from "../redis.js";
import { consumeToken, type RateLimit } from "../services/ratelimit.js";
import { setAuthCookies } from "./cookies.js";
import { issueCsrfToken } from "./csrf.js";
import { readAccessClaims, requireAuth, type AuthedRequest } from "./middleware.js";
import { verifyPassword } from "./password.js";
import type { UserRepository } from "./repos.js";
import type { AuthService } from "./service.js";
import {
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp.js";
import type { TotpRepository } from "./totpRepo.js";
import type { User } from "./types.js";
import {
  totpDisableSchema,
  totpEnrolConfirmSchema,
  totpEnrolStartSchema,
  totpLoginSchema,
  validateBody,
} from "./validation.js";

/** ── Authenticator-app second factor: the routes ───────────────────────────
 *  Three things happen here and they are deliberately kept apart:
 *
 *   - FINISHING a sign-in (`/auth/totp/login`): the password was right, a code is owed.
 *   - ENROLLING (`/auth/totp/enrol/*`): generating a secret and proving the app holds it.
 *   - DISABLING (`/auth/totp/disable`): which costs a current code.
 *
 *  None of them is reachable by someone who has not already proven the password — either a
 *  live session, or the single-use pending token the password route hands out in place of
 *  one. That ordering is what makes this a SECOND factor: a code generator on its own opens
 *  nothing.
 */

export interface TotpRouterDeps {
  auth: AuthService;
  users: UserRepository;
  totp: TotpRepository;
  audit: AuditLogger;
  redis: RedisClient;
  now: () => number;
}

/** What a pending token may be spent on. A token minted for `verify` cannot start an
 *  enrolment, and one minted for `enrol` cannot be turned into a session without enrolling —
 *  otherwise the weaker of the two paths would be the one everyone could take. */
export type TotpPendingPurpose = "verify" | "enrol";

interface TotpPendingRecord {
  userId: string;
  purpose: TotpPendingPurpose;
}

/** Same five minutes as the SMS step: long enough to find the phone and open the app. */
export const TOTP_VERIFY_PENDING_TTL_MS = 5 * 60 * 1000;
/** First-time enrolment is slower — install or open an app, type a 32-character key, write
 *  ten codes down — so it gets longer. Still a deadline: until it is met, this is a token
 *  that a password alone obtained. */
export const TOTP_ENROL_PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * Code attempts per account, across sign-in, enrolment and disabling.
 *
 * Three codes are valid at any instant out of a million, so each guess has a three-in-a-
 * million chance. Five tries and then one every two minutes is roughly 725 guesses a day —
 * about a 0.2% daily chance for an attacker who ALREADY has the password and keeps it up
 * around the clock, against a legitimate user who needs one try. Deliberately the same shape
 * as the password limiter, so there is one number to reason about.
 *
 * It cannot be used to lock a member of staff out from the outside: the bucket is only
 * touched after a valid pending token or session has been presented, both of which require
 * the password.
 */
const TOTP_CODE_LIMIT: RateLimit = { capacity: 5, ratePerSec: 1 / 120 };
const TOTP_CODE_IP_LIMIT: RateLimit = { capacity: 20, ratePerSec: 1 / 30 };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const isStaff = (u: User) => u.role === "admin" || u.role === "super_admin";

/**
 * Mint a pending token for someone whose password has just been accepted.
 *
 * Only a digest is stored, as the key. The token is 192 random bits, so looking it up by its
 * hash is the comparison — there is no stored value for a timing difference to reveal.
 */
export async function startTotpPending(
  redis: RedisClient,
  userId: string,
  purpose: TotpPendingPurpose,
): Promise<{ pendingToken: string; expiresInMs: number }> {
  const pendingToken = randomBytes(24).toString("base64url");
  const expiresInMs = purpose === "enrol" ? TOTP_ENROL_PENDING_TTL_MS : TOTP_VERIFY_PENDING_TTL_MS;
  const record: TotpPendingRecord = { userId, purpose };
  await redis.set(
    keys.totpPending(sha256(pendingToken)),
    JSON.stringify(record),
    "PX",
    expiresInMs,
  );
  return { pendingToken, expiresInMs };
}

export function createTotpRouter(
  deps: TotpRouterDeps,
  /** The auth router's allowlisting serialiser, passed in rather than imported so the two
   *  modules do not import each other and there is still exactly one definition of what a
   *  user looks like to a browser. */
  publicUser: (u: User) => unknown,
): Router {
  const router = Router();
  const ua = (req: Request) => (req.headers["user-agent"] as string | undefined) ?? "";
  const clientIp = (req: Request) => req.ip ?? req.socket?.remoteAddress ?? "unknown";

  async function readPending(
    token: string,
    purpose: TotpPendingPurpose,
  ): Promise<{ key: string; userId: string } | null> {
    const key = keys.totpPending(sha256(token));
    const stored = await deps.redis.get(key);
    if (!stored) return null;
    const record = JSON.parse(stored) as TotpPendingRecord;
    return record.purpose === purpose ? { key, userId: record.userId } : null;
  }

  /** True if another attempt is allowed. Answers the 429 itself when it is not. */
  async function withinCodeLimit(req: Request, res: Response, userId: string): Promise<boolean> {
    const withinAccount = await consumeToken(
      deps.redis,
      keys.bucket("totp-code", userId),
      TOTP_CODE_LIMIT,
      deps.now(),
    );
    const withinIp = await consumeToken(
      deps.redis,
      keys.bucket("totp-code-ip", clientIp(req)),
      TOTP_CODE_IP_LIMIT,
      deps.now(),
    );
    if (withinAccount && withinIp) return true;
    logger.warn("authenticator code attempts rate-limited", {
      userId,
      scope: withinAccount ? "ip" : "account",
    });
    res.status(429).json({ error: "too-many-attempts" });
    return false;
  }

  /**
   * Is this code right, AND unused?
   *
   * Both halves, always together. `verifyTotp` alone would accept a code a second time for
   * as long as it stays inside the window — up to ninety seconds in which a code read over a
   * shoulder or relayed by a phishing page is as good as the phone itself.
   */
  async function codeAccepted(userId: string, secretEnc: string, code: string): Promise<boolean> {
    const secret = decryptTotpSecret(secretEnc, userId);
    if (!secret) {
      // Not the user's mistake and not something to tell them about: the row was tampered
      // with, moved from another account, or sealed under a different key.
      logger.error("stored authenticator secret did not decrypt", { userId });
      return false;
    }
    const step = verifyTotp(secret, code, deps.now());
    if (step == null) return false;
    return deps.totp.acceptStep(userId, step);
  }

  /**
   * Who is enrolling — and by which door.
   *
   * Two doors, because there are two honest situations. A signed-in member of staff adding an
   * authenticator has a session. A super admin signing in for the first time has NO session,
   * by design: handing them one on a password alone is the hole this closes, so they hold a
   * pending token that authorises exactly these two routes and nothing else.
   *
   * The pending token wins when both are present. It is the narrower grant, and a request
   * that names it is saying which login it is finishing.
   */
  async function enrolPrincipal(
    req: Request,
    res: Response,
  ): Promise<{ user: User; pendingKey: string | null } | null> {
    const { pendingToken } = req.body as { pendingToken?: string };
    let userId: string;
    let pendingKey: string | null = null;
    if (pendingToken) {
      const pending = await readPending(pendingToken, "enrol");
      if (!pending) {
        res.status(401).json({ error: "enrolment-expired" });
        return null;
      }
      userId = pending.userId;
      pendingKey = pending.key;
    } else {
      const claims = readAccessClaims(req);
      if (!claims) {
        res.status(401).json({ error: "unauthorized" });
        return null;
      }
      userId = claims.sub;
    }

    // Role and block state from the DATABASE, as `requireStaff` does and for its reason: a
    // token says what someone was when it was minted, and a demoted or deactivated operator
    // must not be able to attach a fresh credential to the account on the way out.
    const user = await deps.users.getById(userId);
    if (!user || user.blockedAt != null) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    if (!isStaff(user)) {
      res.status(403).json({ error: "forbidden", required: "admin" });
      return null;
    }
    return { user, pendingKey };
  }

  // ── finish a staff sign-in ─────────────────────────────────────────────────
  router.post(
    "/auth/totp/login",
    validateBody(totpLoginSchema),
    asyncRoute(async (req, res) => {
      const { pendingToken, code, recoveryCode } = req.body as {
        pendingToken: string;
        code?: string;
        recoveryCode?: string;
      };
      try {
        const pending = await readPending(pendingToken, "verify");
        if (!pending) {
          // The same code the SMS step answers with, so the client has one "start again
          // from the password" path rather than two.
          res.status(401).json({ error: "mfa-expired" });
          return;
        }
        if (!(await withinCodeLimit(req, res, pending.userId))) return;

        const user = await deps.users.getById(pending.userId);
        const credential = await deps.totp.get(pending.userId);
        // Re-read rather than trusted from the password step: five minutes is long enough
        // for a super admin to deactivate this operator, and that must hold here too.
        if (!user || user.blockedAt != null || !isStaff(user) || credential?.status !== "active") {
          res.status(401).json({ error: "mfa-expired" });
          return;
        }

        const usedRecoveryCode = Boolean(recoveryCode);
        const ok = recoveryCode
          ? await deps.totp.consumeRecoveryCode(user.id, hashRecoveryCode(recoveryCode), deps.now())
          : await codeAccepted(user.id, credential.secretEnc, code!);
        if (!ok) {
          // One answer for a wrong code, a replayed code and a spent recovery code. Telling a
          // caller "that one was right, but already used" confirms a captured code was real.
          logger.warn("authenticator second factor refused", {
            userId: user.id,
            kind: usedRecoveryCode ? "recovery" : "totp",
          });
          res.status(401).json({ error: "totp-invalid" });
          return;
        }

        // Single-use, and deleted only once the factor has passed — a mistyped code does not
        // cost the operator their password step.
        await deps.redis.del(pending.key);

        let recoveryCodesRemaining: number | undefined;
        if (usedRecoveryCode) {
          recoveryCodesRemaining = await deps.totp.recoveryCodesRemaining(user.id);
          await deps.audit.record({
            action: "auth.totp_recovery_code_used",
            actorId: user.id,
            actorRole: user.role,
            subjectType: "user",
            subjectId: user.id,
            metadata: { remaining: recoveryCodesRemaining },
            ip: clientIp(req),
          });
        }

        const issued = await deps.auth.issueFor(user, ua(req));
        setAuthCookies(res, issued.accessToken, issued.refreshToken);
        logger.info("staff signed in with password and authenticator", {
          userId: user.id,
          kind: usedRecoveryCode ? "recovery" : "totp",
        });
        res.json({
          user: publicUser(issued.user),
          csrfToken: issueCsrfToken(res),
          // Only after a recovery code, so the screen can say "you have two left" at the one
          // moment it matters.
          ...(recoveryCodesRemaining != null ? { recoveryCodesRemaining } : {}),
        });
      } catch (err) {
        logger.error("authenticator sign-in failed", { err: String(err) });
        res.status(500).json({ error: "login-failed" });
      }
    }),
  );

  // ── enrol: generate a secret ───────────────────────────────────────────────
  router.post(
    "/auth/totp/enrol/start",
    validateBody(totpEnrolStartSchema),
    asyncRoute(async (req, res) => {
      const principal = await enrolPrincipal(req, res);
      if (!principal) return;
      const { user, pendingKey } = principal;

      if (!pendingKey) {
        // From a session, the password is asked for again. A session is a cookie on a
        // machine; without this, anyone who sat down at an unlocked console could bind the
        // operator's account to THEIR phone, and the operator would be locked out by the very
        // feature meant to protect them. The pending-token door needs no such check — that
        // token only exists because the password was typed seconds ago.
        if (!(await withinCodeLimit(req, res, user.id))) return;
        const { password } = req.body as { password?: string };
        const hash = await deps.users.getPasswordHash(user.id);
        if (!password || !(await verifyPassword(password, hash))) {
          res.status(401).json({ error: "current-password-invalid" });
          return;
        }
      }

      const secret = generateTotpSecret();
      const saved = await deps.totp.savePending(
        user.id,
        encryptTotpSecret(secret, user.id),
        deps.now(),
      );
      if (!saved) {
        // Already enrolled. Replacing a working authenticator goes through `disable`, which
        // costs a code from the old one.
        res.status(409).json({ error: "totp-already-enabled" });
        return;
      }

      // The one and only time the secret leaves the server. Not logged, and marked
      // uncacheable so it does not sit in a proxy or a browser's disk cache afterwards.
      res.setHeader("Cache-Control", "no-store");
      res.json({
        secret: base32Encode(secret),
        otpauthUri: otpauthUri(secret, user.username ?? user.displayName),
      });
    }),
  );

  // ── enrol: prove the app holds it ──────────────────────────────────────────
  router.post(
    "/auth/totp/enrol/confirm",
    validateBody(totpEnrolConfirmSchema),
    asyncRoute(async (req, res) => {
      const principal = await enrolPrincipal(req, res);
      if (!principal) return;
      const { user, pendingKey } = principal;
      const { code } = req.body as { code: string };

      if (!(await withinCodeLimit(req, res, user.id))) return;

      const credential = await deps.totp.get(user.id);
      if (!credential || credential.status !== "pending") {
        res.status(409).json({ error: "totp-not-pending" });
        return;
      }
      const secret = decryptTotpSecret(credential.secretEnc, user.id);
      const step = secret ? verifyTotp(secret, code, deps.now()) : null;
      if (step == null) {
        res.status(401).json({ error: "totp-invalid" });
        return;
      }

      // Generated here and returned once. Only their digests are kept, so there is no "show
      // me my codes again" — losing them means disabling and enrolling afresh.
      const recoveryCodes = generateRecoveryCodes();
      // The confirming step becomes the replay floor, so the code that enrolled the app
      // cannot be turned straight around and used to sign in.
      const activated = await deps.totp.activate(
        user.id,
        step,
        deps.now(),
        recoveryCodes.map(hashRecoveryCode),
      );
      if (!activated) {
        res.status(409).json({ error: "totp-not-pending" });
        return;
      }

      await deps.audit.record({
        action: "auth.totp_enrolled",
        actorId: user.id,
        actorRole: user.role,
        subjectType: "user",
        subjectId: user.id,
        metadata: { via: pendingKey ? "first-sign-in" : "session" },
        ip: clientIp(req),
      });
      logger.info("authenticator enrolled", { userId: user.id });

      res.setHeader("Cache-Control", "no-store");
      if (!pendingKey) {
        res.json({ recoveryCodes });
        return;
      }

      // First sign-in: both factors now exist and both have just been demonstrated, so THIS
      // is the moment the session the password route withheld is finally issued.
      await deps.redis.del(pendingKey);
      const issued = await deps.auth.issueFor(user, ua(req));
      setAuthCookies(res, issued.accessToken, issued.refreshToken);
      res.json({
        recoveryCodes,
        user: publicUser(issued.user),
        csrfToken: issueCsrfToken(res),
      });
    }),
  );

  // ── turn it off ────────────────────────────────────────────────────────────
  router.post(
    "/auth/totp/disable",
    requireAuth,
    validateBody(totpDisableSchema),
    asyncRoute(async (req: AuthedRequest, res) => {
      const { code } = req.body as { code: string };
      const user = await deps.users.getById(req.user!.sub);
      if (!user || user.blockedAt != null) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      if (!(await withinCodeLimit(req, res, user.id))) return;

      const credential = await deps.totp.get(user.id);
      if (!credential || credential.status !== "active") {
        res.status(409).json({ error: "totp-not-enabled" });
        return;
      }
      // A current code, not a recovery code and not the password. Removing the second factor
      // is the single most useful thing a stolen session could do, so it costs the one thing
      // a stolen session does not come with.
      if (!(await codeAccepted(user.id, credential.secretEnc, code))) {
        res.status(401).json({ error: "totp-invalid" });
        return;
      }

      await deps.totp.remove(user.id);
      await deps.audit.record({
        action: "auth.totp_disabled",
        actorId: user.id,
        actorRole: user.role,
        subjectType: "user",
        subjectId: user.id,
        ip: clientIp(req),
      });
      logger.info("authenticator disabled", { userId: user.id });
      // For a super admin this does NOT fall back to a password alone: with no authenticator
      // on the account, the next sign-in stops at enrolment before any session exists.
      res.json({ ok: true });
    }),
  );

  // ── what do I have ─────────────────────────────────────────────────────────
  router.get(
    "/auth/totp/status",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res) => {
      const user = await deps.users.getById(req.user!.sub);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }
      const credential = await deps.totp.get(user.id);
      const enabled = credential?.status === "active";
      // Facts about the credential, never the credential: no secret, no code hashes.
      res.json({
        /** Staff only. Participants sign in with a code by text and are not offered this. */
        available: isStaff(user),
        /** A super admin has no other second factor, so theirs is not optional. */
        required: user.role === "super_admin",
        enabled,
        enabledAt: enabled ? credential.activatedAt : null,
        recoveryCodesRemaining: enabled ? await deps.totp.recoveryCodesRemaining(user.id) : 0,
      });
    }),
  );

  return router;
}
