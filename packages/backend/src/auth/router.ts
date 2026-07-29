import { Router, type Request, type Response } from "express";
import type { RedisClient } from "../redis.js";
import { logger } from "../logger.js";
import { AuthService } from "./service.js";
import type { OtpService } from "./otp.js";
import type { KycProvider } from "./providers.js";
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
  redis: RedisClient;
  now: () => number;
}

/** Strip internal fields before returning a user to the client. */
function publicUser(u: User) {
  return {
    id: u.id,
    phone: u.phone,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    kycStatus: u.kycStatus,
  };
}

const kycRefKey = (reference: string) => `kyc:ref:${reference}`;

/**
 * Stage A — Identity & Verification. Phone-OTP login issuing httpOnly access + rotating
 * refresh cookies, plus the KYC start/callback seam. Every endpoint validates its body and,
 * where it mutates a principal's state, checks auth/role at the API layer.
 */
export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const ua = (req: Request) => (req.headers["user-agent"] as string | undefined) ?? "";

  // ── request an OTP ─────────────────────────────────────────────────────────
  router.post("/auth/otp/request", validateBody(otpRequestSchema), async (req, res) => {
    const { phone } = req.body as { phone: string };
    try {
      const result = await deps.otp.request(phone);
      if (!result.ok) {
        res.status(429).json({ error: "too-many-requests", retryAfterMinutes: 60 });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error("otp request failed", { err: String(err) });
      res.status(500).json({ error: "otp-request-failed" });
    }
  });

  // ── verify OTP → log in (find-or-create user) ──────────────────────────────
  router.post("/auth/otp/verify", validateBody(otpVerifySchema), async (req, res) => {
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
      logger.error("otp verify failed", { err: String(err) });
      res.status(500).json({ error: "login-failed" });
    }
  });

  // ── rotate the session ─────────────────────────────────────────────────────
  router.post("/auth/refresh", async (req, res) => {
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
  });

  // ── log out (revoke) ───────────────────────────────────────────────────────
  router.post("/auth/logout", async (req, res) => {
    const token = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    try {
      if (token) await deps.auth.logout(token);
    } catch (err) {
      logger.error("logout failed", { err: String(err) });
    }
    clearAuthCookies(res);
    res.json({ ok: true });
  });

  // ── who am I ───────────────────────────────────────────────────────────────
  router.get("/auth/me", requireAuth, async (req: AuthedRequest, res: Response) => {
    const user = await deps.users.getById(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    res.json({ user: publicUser(user) });
  });

  // ── update my profile / select a role (never admin) ────────────────────────
  router.patch(
    "/auth/me",
    requireAuth,
    validateBody(updateMeSchema),
    async (req: AuthedRequest, res: Response) => {
      const patch = req.body as { displayName?: string; email?: string; role?: User["role"] };
      const updated = await deps.users.update(req.user!.sub, { ...patch, updatedAt: deps.now() });
      res.json({ user: publicUser(updated) });
    },
  );

  // ── KYC: start (helpers only) ──────────────────────────────────────────────
  router.post(
    "/auth/kyc/start",
    requireAuth,
    requireRole("helper"),
    async (req: AuthedRequest, res: Response) => {
      try {
        const userId = req.user!.sub;
        const { reference, verificationUrl } = await deps.kyc.start(userId);
        // Correlate the async callback back to this user (masked reference only).
        await deps.redis.set(kycRefKey(reference), userId, "EX", 86_400);
        await deps.users.update(userId, { kycStatus: "pending", updatedAt: deps.now() });
        res.json({ verificationUrl });
      } catch (err) {
        logger.error("kyc start failed", { err: String(err) });
        res.status(500).json({ error: "kyc-start-failed" });
      }
    },
  );

  // ── KYC: provider callback (webhook) ───────────────────────────────────────
  // A real provider signs this; the sandbox trusts the body. Kept unauthenticated because
  // it's provider-to-server — production must verify the provider signature here.
  router.post("/auth/kyc/callback", validateBody(kycCallbackSchema), async (req, res) => {
    try {
      const decision = deps.kyc.interpretCallback(req.body);
      if (!decision) {
        res.status(400).json({ error: "unrecognized-callback" });
        return;
      }
      const userId = await deps.redis.get(kycRefKey(decision.reference));
      if (!userId) {
        res.status(404).json({ error: "unknown-reference" });
        return;
      }
      await deps.users.update(userId, {
        kycStatus: decision.decision,
        updatedAt: deps.now(),
      });
      await deps.redis.del(kycRefKey(decision.reference));
      res.json({ ok: true });
    } catch (err) {
      logger.error("kyc callback failed", { err: String(err) });
      res.status(500).json({ error: "kyc-callback-failed" });
    }
  });

  router.get("/auth/kyc/status", requireAuth, async (req: AuthedRequest, res: Response) => {
    const user = await deps.users.getById(req.user!.sub);
    res.json({ kycStatus: user?.kycStatus ?? "unverified" });
  });

  return router;
}
