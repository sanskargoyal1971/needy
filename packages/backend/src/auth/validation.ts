import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

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
