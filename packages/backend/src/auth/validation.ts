import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "./password.js";

/** Shared request schemas. Every auth endpoint validates its body through one of these —
 *  the same rigor the brief mandates for all new endpoints. */

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{7,14}$/, "enter a valid phone number");

export const otpRequestSchema = z.object({ phone: phoneSchema });

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{4,8}$/, "enter the code we sent you"),
});

/** Bounded at both ends. The floor is the policy; the ceiling exists because scrypt hashes
 *  whatever it is handed, so an unbounded field is a CPU-exhaustion primitive that costs an
 *  attacker one request. Deliberately NOT trimmed — a leading or trailing space is a legitimate
 *  character in a password, and silently removing it locks people out of what they typed. */
const passwordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/** Letters, digits, dot, dash and underscore. No spaces and no `@`, so a username can never be
 *  mistaken for a phone number or an email and the login route's branch stays unambiguous. */
export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, "letters, numbers, dots, dashes and underscores only");

/** Exactly one identifier. A body carrying both would leave the route deciding which one it
 *  meant, and "whichever matched" is how an account gets reached by the wrong door. */
export const passwordLoginSchema = z
  .object({
    phone: phoneSchema.optional(),
    username: usernameSchema.optional(),
    password: passwordSchema,
  })
  .refine((v) => Boolean(v.phone) !== Boolean(v.username), {
    message: "provide either a phone number or a username",
    path: ["phone"],
  });

/** The admin second factor. `pendingToken` is what proves the password step already passed —
 *  without it this route would be a plain OTP login wearing a different name. */
export const passwordMfaSchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{4,8}$/, "enter the code we sent you"),
  pendingToken: z.string().min(16).max(128),
});

// ── authenticator-app second factor ──────────────────────────────────────────

/** Exactly six digits. Tighter than the SMS schema's 4–8 because this length is fixed by the
 *  algorithm rather than by configuration. */
const totpCodeSchema = z.string().regex(/^\d{6}$/, "enter the 6-digit code from your app");
/** Bounded like every other token that is hashed and looked up. */
const pendingTokenSchema = z.string().min(16).max(128);

/** Finishing a staff sign-in: the token from the password step, plus EITHER a code from the
 *  app or one recovery code. Never both — "whichever matched" is not a rule. */
export const totpLoginSchema = z
  .object({
    pendingToken: pendingTokenSchema,
    code: totpCodeSchema.optional(),
    recoveryCode: z.string().trim().min(12).max(32).optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: "provide either a code or a recovery code",
    path: ["code"],
  });

/** Starting enrolment. A signed-in member of staff re-enters their password; a super admin
 *  mid-way through their first sign-in presents the pending token instead. Which of the two
 *  applies is decided in the route, which is the only place that can see a session. */
export const totpEnrolStartSchema = z.object({
  pendingToken: pendingTokenSchema.optional(),
  password: passwordSchema.optional(),
});

export const totpEnrolConfirmSchema = z.object({
  pendingToken: pendingTokenSchema.optional(),
  code: totpCodeSchema,
});

export const totpDisableSchema = z.object({ code: totpCodeSchema });

export const setPasswordSchema = z.object({
  /** Required whenever the account already has one. Checked in the route, because only it
   *  knows whether a password exists — a schema cannot see the account. */
  currentPassword: passwordSchema.optional(),
  newPassword: passwordSchema,
});

export const adminSetPasswordSchema = z.object({
  newPassword: passwordSchema,
});

export const updateMeSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    email: z.string().email().optional(),
    // A user may select these roles for themselves; "admin" is never self-assignable.
    role: z.enum(["requester", "helper", "both"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });

export const kycCallbackSchema = z
  .object({
    reference: z.string().min(1),
    decision: z.enum(["verified", "rejected"]).optional(),
  })
  .passthrough();

/** Body-validation middleware. Replaces req.body with the parsed, typed value on success. */
export function validateBody<T>(schema: z.ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid-input", details: parsed.error.flatten() });
      return;
    }
    req.body = parsed.data;
    next();
  };
}
