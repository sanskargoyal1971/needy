import express, { Router, type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DocumentKind } from "@needy/shared";
import { config } from "../config.js";
import type { AuditLogger } from "../audit/log.js";
import { emitSignal, type AbuseRepository } from "../domain/abuseStore.js";
import { keys } from "../domain/keys.js";
import type { RedisClient } from "../redis.js";
import { logger } from "../logger.js";
import { asyncRoute } from "../http/asyncRoute.js";
import { AuthService, PhoneBlockedError } from "./service.js";
import { passwordProblem, verifyPassword, PASSWORD_MIN_LENGTH } from "./password.js";
import { consumeToken, type RateLimit } from "../services/ratelimit.js";
import type { OtpService } from "./otp.js";
import { KYC_SIGNATURE_HEADER, verifyKycSignature, type KycProvider } from "./providers.js";
import type { KycDocumentRepository } from "../onboarding/repos.js";
import type { UserRepository } from "./repos.js";
import type { TotpRepository } from "./totpRepo.js";
import { createTotpRouter, startTotpPending } from "./totpRouter.js";
import type { User } from "./types.js";
import { clearAuthCookies, parseCookies, REFRESH_COOKIE, setAuthCookies } from "./cookies.js";
import { issueCsrfToken } from "./csrf.js";
import { requireAuth, requireRole, type AuthedRequest } from "./middleware.js";
import {
  otpRequestSchema,
  otpVerifySchema,
  kycCallbackSchema,
  passwordLoginSchema,
  passwordMfaSchema,
  setPasswordSchema,
  updateMeSchema,
  validateBody,
} from "./validation.js";

export interface AuthRouterDeps {
  auth: AuthService;
  otp: OtpService;
  kyc: KycProvider;
  users: UserRepository;
  /** Authenticator-app credentials. Required, not optional: a router built without it would
   *  have to decide what a super admin's second factor is when there is nowhere to look one
   *  up, and every answer to that is either a lockout or a bypass. */
  totp: TotpRepository;
  /** Enrolling, disabling and spending a recovery code are all written down. */
  audit: AuditLogger;
  documents: KycDocumentRepository;
  redis: RedisClient;
  /** Behavioural signals. Only one is emitted from here — a blocked number trying again. */
  abuse: AbuseRepository;
  now: () => number;
}

/**
 * Strip internal fields before returning a user to the client.
 *
 * Assembled by hand rather than spreading the row and deleting: a spread means every column
 * added later is exposed by default, and the columns added later here are `reviewedBy`,
 * `reviewedAt` and `blockedAt` — reviewer-side facts that are staff's business, not the
 * subject's. An allowlist fails safe; a denylist fails open.
 *
 * `documents` is passed in rather than read here because most callers already hold the list
 * and the ones that don't (login, refresh) genuinely have nothing to show yet.
 */
function publicUser(u: User, documents: DocumentKind[] = []) {
  return {
    id: u.id,
    phone: u.phone,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    kycStatus: u.kycStatus,
    onboardingStatus: u.onboardingStatus,
    dateOfBirth: u.dateOfBirth,
    gender: u.gender,
    areaLabel: u.areaLabel,
    // The coarse coordinates behind the label, so the request screen can seed its pin from
    // the user's own home area when the device has no fix. Their own data, already shown to
    // them as a place name — and coarse by construction, which is why it is safe to return
    // where a live position would not be.
    areaLat: u.areaLat,
    areaLng: u.areaLng,
    rejectionReason: u.rejectionReason,
    // The FACT of a password, so the account screen can say "you have one" rather than
    // guessing. The hash itself is not on `User` at all — it lives behind its own repository
    // method, which is what stops it riding an allowlist out to a browser.
    passwordSetAt: u.passwordSetAt,
    documents,
  };
}

// ── KYC callback authenticity plumbing (audit A5) ────────────────────────────

/** The one route whose raw bytes must survive JSON parsing, exported so the composition root
 *  can scope the raw-body capture to exactly this path (see `kycRawBodyParser`). */
export const KYC_CALLBACK_PATH = "/auth/kyc/callback";

/**
 * Password attempts, bounded on both scopes.
 *
 * Tighter than the OTP limiter because a password is guessable in a way a freshly minted
 * random code is not: five tries then one every two minutes is generous for someone
 * mistyping and hopeless for anyone working through a list. The per-IP bucket is the half
 * that C15 established — per-phone alone lets an attacker walk a list of numbers unbounded.
 */
const PASSWORD_LOGIN_LIMIT: RateLimit = { capacity: 5, ratePerSec: 1 / 120 };
const PASSWORD_LOGIN_IP_LIMIT: RateLimit = { capacity: 20, ratePerSec: 1 / 30 };

/** How long the admin has to enter the second factor after the password is accepted. Long
 *  enough for an SMS to arrive and be typed, short enough that an abandoned half-login is not
 *  a standing ticket. */
const MFA_PENDING_TTL_MS = 5 * 60 * 1000;

/** Verification attempts from one address. Generous for a household or an office behind one
 *  NAT — thirty in a burst — and useless for a script. */
const OTP_VERIFY_IP_LIMIT: RateLimit = { capacity: 30, ratePerSec: 30 / 3600 };

/** How long a started verification stays claimable. A provider may take a while (document
 *  review, manual escalation), but an unbounded nonce is a permanently valid ticket. */
const KYC_NONCE_TTL_SECONDS = 86_400;

/** Request carrying the raw body bytes stashed by `kycRawBodyParser`. */
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * `express.json()` consumes the request stream, so by the time a handler sees `req.body` the
 * exact bytes the provider signed are gone — and re-serialising `req.body` is NOT equivalent
 * (key order, whitespace and duplicate keys all change the HMAC input, which is precisely the
 * wiggle room a signature is supposed to remove).
 *
 * This is a normal JSON parser that additionally stashes the raw buffer. Mount it for
 * `KYC_CALLBACK_PATH` *before* the app-wide `express.json()`: it parses that one path itself
 * and body-parser's own `req._body` guard makes the later app-wide parser skip it. JSON parsing
 * is not disabled or altered anywhere else, and no other route pays the memory cost of keeping
 * a second copy of its body.
 */
export const kycRawBodyParser = express.json({
  // Mirror the app-wide bound. Because this parser runs FIRST and marks `req._body`, the
  // app-wide `express.json({ limit: "64kb" })` skips this path entirely — so without an explicit
  // limit here the callback silently inherited body-parser's 100kb default and was the one route
  // that escaped the size bound (and it keeps a second, raw copy of the body besides).
  limit: "64kb",
  verify: (req, _res, buf) => {
    (req as RawBodyRequest).rawBody = Buffer.from(buf);
  },
});

/** The stored nonce record. Bound to the user who STARTED verification — this, not anything in
 *  the callback body, is what decides whose KYC status may change. */
interface KycNonceRecord {
  userId: string;
  /** SHA-256 of the nonce, so a read-only leak of Redis doesn't hand over usable tickets. */
  nonceHash: string;
  issuedAt: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Constant-time equality for two hex digests of equal expected length. */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Audit A5(a) — the callback had NO authenticity check whatsoever ("a real provider signs this;
 * the sandbox trusts the body"), which in practice meant production trusted the body too. Any
 * unauthenticated caller who could reach the endpoint could hand us a decision. Every callback
 * must now carry an HMAC-SHA256 of the RAW body under `x-needy-kyc-signature`, compared in
 * constant time; unsigned and badly-signed requests are refused outright before the body is
 * looked at.
 */
function requireKycSignature(req: Request, res: Response, next: () => void): void {
  const raw = (req as RawBodyRequest).rawBody;
  if (!raw) {
    // A misconfigured deployment (raw capture not mounted) must FAIL, not fall back to
    // trusting the body — that fallback is the bug we are fixing.
    logger.error("kyc callback raw body unavailable — kycRawBodyParser is not mounted", {
      path: KYC_CALLBACK_PATH,
    });
    res.status(500).json({ error: "kyc-callback-misconfigured" });
    return;
  }
  const presented = req.headers[KYC_SIGNATURE_HEADER];
  const ok = verifyKycSignature(
    raw,
    typeof presented === "string" ? presented : undefined,
    config.auth.kycCallbackSecret,
  );
  if (!ok) {
    // No detail in the response: a signature oracle is worth more to an attacker than a
    // helpful error is to the provider, whose integration is verified once at setup.
    logger.warn("kyc callback rejected — missing or invalid signature", {
      hasSignature: typeof presented === "string",
    });
    res.status(401).json({ error: "invalid-signature" });
    return;
  }
  next();
}

/** The callback body: the existing shared shape plus the server-issued nonce, which is now
 *  mandatory. Extending the shared schema rather than restating it keeps the reference/decision
 *  rules in one place. Any `userId` in the body still passes through the `.passthrough()` and is
 *  still deliberately IGNORED downstream. */
const kycCallbackBodySchema = kycCallbackSchema.extend({
  nonce: z.string().min(16).max(256),
});

/**
 * Stage A — Identity & Verification. Phone-OTP login issuing httpOnly access + rotating
 * refresh cookies, plus the KYC start/callback seam. Every endpoint validates its body and,
 * where it mutates a principal's state, checks auth/role at the API layer.
 */
export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const ua = (req: Request) => (req.headers["user-agent"] as string | undefined) ?? "";
  /** Source address for the per-IP OTP limiter. `req.ip` honours `trust proxy` when the app
   *  sets it; the socket address is the fallback so the limiter never silently degrades to a
   *  single shared bucket. */
  const clientIp = (req: Request) => req.ip ?? req.socket?.remoteAddress ?? "unknown";

  // ── request an OTP ─────────────────────────────────────────────────────────
  router.post(
    "/auth/otp/request",
    validateBody(otpRequestSchema),
    asyncRoute(async (req, res) => {
      const { phone } = req.body as { phone: string };
      try {
        // Audit C15 — the per-IP argument: per-phone limiting alone let an attacker bomb SMS (and
        // our bill) forever just by walking a list of numbers.
        const result = await deps.otp.request(phone, clientIp(req));
        if (!result.ok) {
          // One undifferentiated 429 for both scopes so a caller can't learn which limiter it hit.
          logger.warn("otp request rate-limited", { scope: result.scope });
          res.status(429).json({ error: "too-many-requests", retryAfterMinutes: 60 });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        logger.error("otp request failed", { err: String(err) });
        res.status(500).json({ error: "otp-request-failed" });
      }
    }),
  );

  // ── verify OTP → log in (find-or-create user) ──────────────────────────────
  router.post(
    "/auth/otp/verify",
    validateBody(otpVerifySchema),
    asyncRoute(async (req, res) => {
      const { phone, code } = req.body as { phone: string; code: string };

      // Guessing is bounded per code, but nothing bounded one source walking many numbers —
      // or burning other people's attempt budgets one phone at a time.
      const withinIp = await consumeToken(
        deps.redis,
        keys.bucket("otp-verify-ip", clientIp(req)),
        OTP_VERIFY_IP_LIMIT,
        deps.now(),
      );
      if (!withinIp) {
        logger.warn("otp verify rate-limited", { scope: "ip" });
        res.status(429).json({ error: "too-many-attempts" });
        return;
      }

      try {
        const check = await deps.otp.verify(phone, code);
        if (!check.ok) {
          res.status(401).json({ error: "otp-invalid", reason: check.reason });
          return;
        }

        // ── staff do not sign in on a one-time code alone ──────────────────────
        // The password route makes an admin present a password AND a code. This route then
        // issued the same session for the code by itself, to any role — so the second factor
        // was optional for exactly the accounts it exists to protect, and a SIM swap on one
        // operator's number was the whole verification console.
        //
        // Checked AFTER the code verifies, not before: refusing up front would tell anyone
        // who types a number whether it belongs to a member of staff.
        const existing = await deps.users.getByPhone(phone);
        if (existing && (existing.role === "admin" || existing.role === "super_admin")) {
          logger.warn("otp-only sign-in refused for a staff account", { userId: existing.id });
          res.status(403).json({ error: "password-required" });
          return;
        }

        const issued = await deps.auth.loginWithPhone(phone, ua(req));
        setAuthCookies(res, issued.accessToken, issued.refreshToken);
        // Rotate the CSRF token as part of establishing the session, and return it so the
        // client has it without a second round trip.
        //
        // This closes a cookie-fixation gap in the double-submit scheme. `GET /auth/csrf` is
        // necessarily unauthenticated (the request that creates a session is itself a mutating
        // request, so requiring a session to get the token needed to make one is a loop with no
        // entry), which means a hostile page can force a victim's browser to accept a token the
        // attacker chose. Minting a new one HERE means the token bound to an authenticated
        // session is always one the server generated after authentication and the attacker has
        // never seen. The Origin check and the custom-header requirement both already stopped
        // the attack; this stops it at the token layer too, so no single check carries it alone.
        res.json({ user: publicUser(issued.user), csrfToken: issueCsrfToken(res) });
      } catch (err) {
        // A blocked number is a decision, not a failure: answer 403 with a distinct code so
        // the client shows the terminal screen instead of "something went wrong, try again".
        if (err instanceof PhoneBlockedError) {
          logger.warn("login refused — phone is blocked");

          // Someone rejected by a human is still trying to get in. One attempt is a person who
          // forgot; a run of them is worth an operator knowing about, especially if the same
          // person then appears under a different number.
          //
          // Attributed to the existing account when there is one. When there is not — the block
          // outlived the account, or the number was blocked before it ever registered — there
          // is nothing to attribute it to, and inventing a subject key from the phone number
          // would put a plaintext identifier of a refused person into a long-lived table. The
          // refusal is still in the application log above either way.
          const blockedUser = await deps.users.getByPhone(phone).catch(() => null);
          if (blockedUser) {
            await emitSignal(deps.abuse, "auth.blocked_phone_retry", blockedUser.id, deps.now());
          }

          res.status(403).json({ error: "phone-blocked" });
          return;
        }
        logger.error("otp verify failed", { err: String(err) });
        res.status(500).json({ error: "login-failed" });
      }
    }),
  );

  // ── sign in with a password ────────────────────────────────────────────────
  //
  // The second way in. Until this existed a verified one-time code was the ONLY thing that
  // could create a session, which left no route at all for someone who cannot receive SMS —
  // a lost handset, a number that has moved on, an operator who needs the console at 3am.
  //
  // The OTP path is untouched and remains both an alternative and the recovery route.
  router.post(
    "/auth/password/login",
    validateBody(passwordLoginSchema),
    asyncRoute(async (req, res) => {
      const { phone, username, password } = req.body as {
        phone?: string;
        username?: string;
        password: string;
      };
      const ip = clientIp(req);
      // One bucket keyed on whichever identifier was supplied, so a username is limited
      // exactly as tightly as a number. Prefixed so `+9198…` and a username `+9198…` — which
      // the schema forbids anyway — could never share a bucket.
      const identifier = phone ? `p:${phone}` : `u:${username}`;

      // Bounded on BOTH scopes, for the reason C15 established on the OTP route: per-phone
      // alone lets an attacker walk a list of numbers unbounded, and per-IP alone lets a
      // distributed attempt grind one account. Tighter than the OTP limiter because a password
      // is guessable in a way a fresh random code is not.
      const withinIdentifier = await consumeToken(
        deps.redis,
        keys.bucket("password-login", identifier),
        PASSWORD_LOGIN_LIMIT,
        deps.now(),
      );
      const withinIp = await consumeToken(
        deps.redis,
        keys.bucket("password-login-ip", ip),
        PASSWORD_LOGIN_IP_LIMIT,
        deps.now(),
      );
      if (!withinIdentifier || !withinIp) {
        logger.warn("password login rate-limited", {
          scope: withinIdentifier ? "ip" : "identifier",
        });
        res.status(429).json({ error: "too-many-attempts" });
        return;
      }

      try {
        const user = phone
          ? await deps.users.getByPhone(phone)
          : await deps.users.getByUsername(username!);
        const issued = phone
          ? await deps.auth.loginWithPassword(phone, password, ua(req))
          : await deps.auth.loginWithUsername(username!, password, ua(req));
        if (!issued) {
          // One answer for every kind of failure — see `loginWithPassword`. A wrong password
          // on a real account and an unknown number are indistinguishable from here.
          if (user) {
            // Attributable, so a grind against one real account becomes visible to an operator
            // even though the caller is told nothing.
            await emitSignal(deps.abuse, "auth.password_failed", user.id, deps.now());
          }
          res.status(401).json({ error: "invalid-credentials" });
          return;
        }

        // ── the staff second factor ────────────────────────────────────────
        //
        // Staff see every live emergency, both parties' phone numbers and every ID document,
        // and a super admin can mint more staff. For them the password is the FIRST factor
        // only. The session is not minted here: the tokens issued above are discarded and a
        // short-lived pending token is returned instead.
        //
        // A super admin used to be exempt, by explicit decision: they sign in by username and
        // have no real number to send a code to, so the strongest account on the platform sat
        // behind one secret. An authenticator app needs no number, which removes the reason
        // for the exemption, and with it the exemption.
        if (issued.user.role === "admin" || issued.user.role === "super_admin") {
          await deps.auth.logout(issued.refreshToken);

          // An enrolled authenticator is THE second factor — for an admin it replaces the
          // text message rather than sitting beside it. Offering both would make the account
          // exactly as strong as the weaker one, and the weaker one is a SIM swap.
          const credential = await deps.totp.get(issued.user.id);
          if (credential?.status === "active") {
            const pending = await startTotpPending(deps.redis, issued.user.id, "verify");
            logger.info("staff password accepted; authenticator code required", {
              userId: issued.user.id,
            });
            res.json({ mfaRequired: true, method: "totp", ...pending });
            return;
          }

          if (issued.user.role === "super_admin") {
            // No authenticator yet — a freshly seeded account, or one that disabled theirs.
            // Two wrong answers are available: sign them in on the password (the hole), or
            // refuse them (a lockout with no way to fix it, since enrolling needs a session).
            // So: still NO session, and a token that authorises enrolment and nothing else.
            // The session is issued by the confirm step, once a code has proven the app.
            const pending = await startTotpPending(deps.redis, issued.user.id, "enrol");
            logger.info("super admin password accepted; authenticator enrolment required", {
              userId: issued.user.id,
            });
            res.json({ enrolmentRequired: true, ...pending });
            return;
          }

          // An admin who has not enrolled an authenticator: the text-message code, as before.
          //
          // The code goes to the number ON THE ACCOUNT, not to one supplied in the request.
          // A super admin assigns that number when they create the admin precisely so it is
          // not the admin's to choose — sending to a request-supplied number would hand the
          // second factor straight back to whoever is doing the signing in.
          const target = issued.user.phone;
          const pendingToken = randomBytes(24).toString("base64url");
          await deps.redis.set(
            keys.mfaPending(target),
            sha256(pendingToken),
            "PX",
            MFA_PENDING_TTL_MS,
          );
          // Sent through the ordinary OTP path so it is rate-limited and delivered exactly as
          // every other code is.
          await deps.otp.request(target, ip);
          logger.info("admin password accepted; second factor required", {
            userId: issued.user.id,
          });
          res.json({
            mfaRequired: true,
            method: "sms",
            pendingToken,
            expiresInMs: MFA_PENDING_TTL_MS,
          });
          return;
        }

        setAuthCookies(res, issued.accessToken, issued.refreshToken);
        res.json({ user: publicUser(issued.user), csrfToken: issueCsrfToken(res) });
      } catch (err) {
        if (err instanceof PhoneBlockedError) {
          res.status(403).json({ error: "phone-blocked" });
          return;
        }
        logger.error("password login failed", { err: String(err) });
        res.status(500).json({ error: "login-failed" });
      }
    }),
  );

  // ── the admin's second factor ──────────────────────────────────────────────
  router.post(
    "/auth/password/mfa",
    validateBody(passwordMfaSchema),
    asyncRoute(async (req, res) => {
      const { phone, code, pendingToken } = req.body as {
        phone: string;
        code: string;
        pendingToken: string;
      };
      try {
        // The pending token is what makes this a SECOND factor rather than a plain OTP login
        // under another name: without it, anyone able to receive the code could sign in as the
        // admin having never known the password. Compared by digest, and consumed on use.
        const expected = await deps.redis.get(keys.mfaPending(phone));
        if (!expected || !hashesMatch(expected, sha256(pendingToken))) {
          res.status(401).json({ error: "mfa-expired" });
          return;
        }

        const check = await deps.otp.verify(phone, code);
        if (!check.ok) {
          res.status(401).json({ error: "otp-invalid", reason: check.reason });
          return;
        }

        const user = await deps.users.getByPhone(phone);
        if (!user) {
          res.status(401).json({ error: "invalid-credentials" });
          return;
        }
        // An admin who has enrolled an authenticator no longer has a text-message door. The
        // password route stops offering it; this refuses a pending token minted in the few
        // minutes BEFORE they enrolled, which would otherwise still open it.
        if ((await deps.totp.get(user.id))?.status === "active") {
          await deps.redis.del(keys.mfaPending(phone));
          res.status(401).json({ error: "mfa-expired" });
          return;
        }
        // Single-use: deleted only once BOTH factors have passed, so a wrong code does not
        // cost the operator their password step.
        await deps.redis.del(keys.mfaPending(phone));

        const issued = await deps.auth.issueFor(user, ua(req));
        setAuthCookies(res, issued.accessToken, issued.refreshToken);
        logger.info("admin signed in with password and second factor", { userId: user.id });
        res.json({ user: publicUser(issued.user), csrfToken: issueCsrfToken(res) });
      } catch (err) {
        logger.error("password mfa failed", { err: String(err) });
        res.status(500).json({ error: "login-failed" });
      }
    }),
  );

  // ── the authenticator-app second factor ────────────────────────────────────
  // Finishing a staff sign-in with a code from an app, and enrolling or disabling one. In
  // its own module (see totpRouter.ts) and mounted here so that everything able to create a
  // session is still reached through this one router.
  router.use(
    createTotpRouter(
      {
        auth: deps.auth,
        users: deps.users,
        totp: deps.totp,
        audit: deps.audit,
        redis: deps.redis,
        now: deps.now,
      },
      (u) => publicUser(u),
    ),
  );

  // ── set or change my own password ──────────────────────────────────────────
  router.post(
    "/auth/me/password",
    requireAuth,
    validateBody(setPasswordSchema),
    asyncRoute(async (req: AuthedRequest, res) => {
      const { currentPassword, newPassword } = req.body as {
        currentPassword?: string;
        newPassword: string;
      };
      const user = await deps.users.getById(req.user!.sub);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }

      // Replacing an existing password requires proving you know it. Without this, anyone who
      // walked up to an unlocked phone could lock the owner out of their own account — and on
      // this platform the account holder may well be someone a family member is trying to
      // control, which is precisely the situation the alarm exists for.
      const existing = await deps.users.getPasswordHash(user.id);
      if (existing) {
        if (!currentPassword || !(await verifyPassword(currentPassword, existing))) {
          res.status(401).json({ error: "current-password-invalid" });
          return;
        }
      }

      const problem = passwordProblem(newPassword, user.phone);
      if (problem) {
        res.status(422).json({ error: "weak-password", problem, minLength: PASSWORD_MIN_LENGTH });
        return;
      }

      await deps.auth.setPassword(user.id, newPassword);
      // Every other session was just revoked, so re-issue for the device doing the changing —
      // otherwise changing your password signs you out of the browser you are holding.
      const issued = await deps.auth.issueFor(user, ua(req));
      setAuthCookies(res, issued.accessToken, issued.refreshToken);
      logger.info("password set by account holder", { userId: user.id });
      res.json({ ok: true, passwordSetAt: deps.now() });
    }),
  );

  // ── remove my password (back to codes only) ────────────────────────────────
  router.delete(
    "/auth/me/password",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res) => {
      const user = await deps.users.getById(req.user!.sub);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }
      await deps.auth.clearPassword(user.id);
      const issued = await deps.auth.issueFor(user, ua(req));
      setAuthCookies(res, issued.accessToken, issued.refreshToken);
      logger.info("password removed by account holder", { userId: user.id });
      res.json({ ok: true });
    }),
  );

  // ── rotate the session ─────────────────────────────────────────────────────
  router.post(
    "/auth/refresh",
    asyncRoute(async (req, res) => {
      const token = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
      if (!token) {
        res.status(401).json({ error: "no-refresh-token" });
        return;
      }
      try {
        const issued = await deps.auth.refresh(token, ua(req));
        if (!issued) {
          clearAuthCookies(res);
          res.status(401).json({ error: "refresh-invalid" });
          return;
        }
        setAuthCookies(res, issued.accessToken, issued.refreshToken);
        res.json({ user: publicUser(issued.user) });
      } catch (err) {
        logger.error("refresh failed", { err: String(err) });
        res.status(500).json({ error: "refresh-failed" });
      }
    }),
  );

  // ── log out (revoke) ───────────────────────────────────────────────────────
  router.post(
    "/auth/logout",
    asyncRoute(async (req, res) => {
      const token = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
      try {
        if (token) await deps.auth.logout(token);
      } catch (err) {
        logger.error("logout failed", { err: String(err) });
      }
      clearAuthCookies(res);
      res.json({ ok: true });
    }),
  );

  // ── CSRF token ─────────────────────────────────────────────────────────────
  //
  // Deliberately NOT behind `requireAuth`. The token has to be obtainable before the request
  // that establishes a session — `POST /auth/otp/verify` is itself a mutating request, and
  // requiring a session to get the token needed to create one is a loop with no entry.
  //
  // Handing a token to an unauthenticated caller costs nothing: it is worthless on its own.
  // It only ever authorises a request that ALSO carries the matching cookie, and a cross-site
  // attacker can neither read this response body (CORS) nor set the header.
  router.get("/auth/csrf", (_req: Request, res: Response) => {
    res.json({ token: issueCsrfToken(res) });
  });

  // ── who am I ───────────────────────────────────────────────────────────────
  router.get(
    "/auth/me",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const user = await deps.users.getById(req.user!.sub);
      if (!user) {
        res.status(404).json({ error: "user-not-found" });
        return;
      }
      // Documents come back with the session so the wizard can resume on a new device from
      // server truth rather than from whatever step localStorage last remembered.
      const docs = await deps.documents.listForUser(user.id);
      res.json({
        user: publicUser(
          user,
          docs.map((d) => d.kind),
        ),
      });
    }),
  );

  // ── update my profile / select a role (never admin) ────────────────────────
  router.patch(
    "/auth/me",
    requireAuth,
    validateBody(updateMeSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const patch = req.body as { displayName?: string; email?: string; role?: User["role"] };
      const updated = await deps.users.update(req.user!.sub, { ...patch, updatedAt: deps.now() });
      res.json({ user: publicUser(updated) });
    }),
  );

  // ── KYC: start (helpers only) ──────────────────────────────────────────────
  router.post(
    "/auth/kyc/start",
    requireAuth,
    requireRole("helper"),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      try {
        const userId = req.user!.sub;
        const { reference, verificationUrl } = await deps.kyc.start(userId);

        // Audit A5(b) — the reference alone used to be the whole correlation, and it was
        // guessable. We now mint a 32-byte CSPRNG nonce here and store only its hash beside the
        // initiating userId: the callback must present the nonce itself, so knowing (or
        // guessing) a reference is not enough to move anyone's KYC status.
        const nonce = randomBytes(32).toString("base64url");
        const record: KycNonceRecord = {
          userId,
          nonceHash: sha256(nonce),
          issuedAt: deps.now(),
        };
        await deps.redis.set(
          keys.kycNonce(reference),
          JSON.stringify(record),
          "EX",
          KYC_NONCE_TTL_SECONDS,
        );

        await deps.users.update(userId, { kycStatus: "pending", updatedAt: deps.now() });

        // The nonce is handed to whoever drives the verification session (a real provider gets
        // it as callback metadata at start; the sandbox hands it back to the caller so the flow
        // is drivable end-to-end). It is single-use and dies with the reference.
        res.json({ verificationUrl, reference, callbackNonce: nonce });
      } catch (err) {
        logger.error("kyc start failed", { err: String(err) });
        res.status(500).json({ error: "kyc-start-failed" });
      }
    }),
  );

  // ── KYC: provider callback (webhook) ───────────────────────────────────────
  // Provider-to-server, so there is no session to authenticate against — authenticity comes
  // from the HMAC over the raw body (requireKycSignature) and authority from the server-issued
  // single-use nonce below. Audit A5: previously this had neither, and the sandbox provider
  // additionally failed open, so anyone who could POST here could verify themselves as a helper.
  router.post(
    KYC_CALLBACK_PATH,
    requireKycSignature,
    validateBody(kycCallbackBodySchema),
    asyncRoute(async (req, res) => {
      try {
        const body = req.body as { reference: string; nonce: string };
        const decision = deps.kyc.interpretCallback(req.body);
        if (!decision) {
          // interpretCallback fails CLOSED — an unrecognised decision changes nothing.
          res.status(400).json({ error: "unrecognized-callback" });
          return;
        }

        const key = keys.kycNonce(decision.reference);
        const stored = await deps.redis.get(key);
        if (!stored) {
          res.status(404).json({ error: "unknown-reference" });
          return;
        }
        const record = JSON.parse(stored) as KycNonceRecord;

        if (!hashesMatch(record.nonceHash, sha256(body.nonce))) {
          logger.warn("kyc callback rejected — nonce mismatch", { reference: decision.reference });
          res.status(403).json({ error: "invalid-nonce" });
          return;
        }

        // One-time use: claim the nonce BEFORE applying the decision. `del` returning 0 means
        // another request already consumed it, so this is a replay (or a duplicate provider
        // delivery) and must not be applied a second time.
        //
        // Claiming first is deliberate. It means a crash between the claim and the update loses
        // the decision (the helper stays `pending` and has to restart verification, which is a
        // supported path), whereas claiming *after* the update would leave a window in which a
        // captured callback replays successfully — a permanently reusable "set this account to
        // verified" token. Losing a decision is recoverable; a replayable verification is not.
        const claimed = await deps.redis.del(key);
        if (claimed === 0) {
          logger.warn("kyc callback rejected — nonce already used", {
            reference: decision.reference,
          });
          res.status(409).json({ error: "nonce-already-used" });
          return;
        }

        // Audit A5(c) — the subject comes from the STORED record, never from the callback body.
        // A body may carry any `userId` it likes; it is ignored, so a caller cannot verify an
        // account other than the one that actually started this verification.
        await deps.users.update(record.userId, {
          kycStatus: decision.decision,
          updatedAt: deps.now(),
        });
        res.json({ ok: true });
      } catch (err) {
        logger.error("kyc callback failed", { err: String(err) });
        res.status(500).json({ error: "kyc-callback-failed" });
      }
    }),
  );

  router.get(
    "/auth/kyc/status",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const user = await deps.users.getById(req.user!.sub);
      res.json({ kycStatus: user?.kycStatus ?? "unverified" });
    }),
  );

  return router;
}
