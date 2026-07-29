import { logger } from "../logger.js";

/**
 * Provider seams for the two external integrations Stage A needs. Each has a sandbox adapter
 * so the flows are fully exercisable here; swapping in a licensed provider (Twilio for SMS,
 * Signzy/HyperVerge/DigiLocker for eKYC) is a single-file change — nothing else in the app
 * knows which implementation is active.
 */

// ── SMS / OTP delivery ───────────────────────────────────────────────────────
export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

/** Dev adapter: logs the message (incl. the OTP) instead of sending. NEVER use in prod —
 *  the OTP is only safe to log because no real SMS leaves the box. */
export class ConsoleSmsProvider implements SmsProvider {
  async send(phone: string, message: string): Promise<void> {
    logger.info("SMS (console sandbox — not delivered)", { phone, message });
  }
}

// A real TwilioSmsProvider would implement the same interface using the Twilio SDK +
// credentials from the secrets vault. Intentionally not built here (no credentials/network).

// ── eKYC ─────────────────────────────────────────────────────────────────────
export type KycDecision = "verified" | "rejected";

export interface KycStartResult {
  /** Provider-side reference we persist (masked) to correlate the async callback. */
  reference: string;
  /** URL/redirect the helper completes verification at (real providers hand this back). */
  verificationUrl: string;
}

export interface KycProvider {
  /** Begin an identity + liveness-selfie check for a helper. */
  start(userId: string): Promise<KycStartResult>;
  /** Validate + interpret a provider callback into a decision. Real providers sign these;
   *  the sandbox trusts a `decision` field so the flow can be driven in tests. */
  interpretCallback(payload: unknown): { reference: string; decision: KycDecision } | null;
}

/** Sandbox adapter: hands back a fake verification URL and accepts a simple callback shape.
 *  Persists nothing raw — the caller stores only status + this opaque reference. */
export class SandboxKycProvider implements KycProvider {
  async start(userId: string): Promise<KycStartResult> {
    const reference = `sandbox_${userId}_${Date.now().toString(36)}`;
    return { reference, verificationUrl: `https://sandbox.kyc.local/verify/${reference}` };
  }
  interpretCallback(payload: unknown): { reference: string; decision: KycDecision } | null {
    if (
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as { reference?: unknown }).reference === "string"
    ) {
      const p = payload as { reference: string; decision?: unknown };
      const decision: KycDecision = p.decision === "rejected" ? "rejected" : "verified";
      return { reference: p.reference, decision };
    }
    return null;
  }
}
