import express, { Router, type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DocumentKind } from "@needy/shared";
import { config } from "../config.js";
import { emitSignal, type AbuseRepository } from "../domain/abuseStore.js";
import { keys } from "../domain/keys.js";
import type { RedisClient } from "../redis.js";
import { logger } from "../logger.js";
import { asyncRoute } from "../http/asyncRoute.js";
import { AuthService, PhoneBlockedError } from "./service.js";
import type { OtpService } from "./otp.js";
import { KYC_SIGNATURE_HEADER, verifyKycSignature, type KycProvider } from "./providers.js";
import type { KycDocumentRepository } from "../onboarding/repos.js";
import type { UserRepository } from "./repos.js";
import type { User } from "./types.js";
import { clearAuthCookies, parseCookies, REFRESH_COOKIE, setAuthCookies } from "./cookies.js";
import { requireAuth, requireRole, type AuthedRequest } from "./middleware.js";
import {
  otpRequestSchema,
  otpVerifySchema,
  kycCallbackSchema,
  updateMeSchema,
  validateBody,
} from "./validation.js";

export interface AuthRouterDeps {
  auth: AuthService;
  otp: OtpService;
  kyc: KycProvider;
  users: UserRepository;
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
    rejectionReason: u.rejectionReason,
    documents,
  };
}

// ── KYC callback authenticity plumbing (audit A5) ────────────────────────────

/** The one route whose raw bytes must survive JSON parsing, exported so the composition root
 *  can scope the raw-body capture to exactly this path (see `kycRawBodyParser`). */
export const KYC_CALLBACK_PATH = "/auth/kyc/callback";

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
      try {
        const check = await deps.otp.verify(phone, code);
        if (!check.ok) {
          res.status(401).json({ error: "otp-invalid", reason: check.reason });
          return;
        }
        const issued = await deps.auth.loginWithPhone(phone, ua(req));
        setAuthCookies(res, issued.accessToken, issued.refreshToken);
        res.json({ user: publicUser(issued.user) });
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
      res.json({ user: publicUser(user, docs.map((d) => d.kind)) });
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
