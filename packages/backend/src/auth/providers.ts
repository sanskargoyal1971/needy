import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
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

/** Show only the last 4 digits of a phone number: enough to correlate a support report or a
 *  local dev run with a log line, not enough for the log itself to become a user directory. */
export function maskPhone(phone: string): string {
  const tail = phone.slice(-4);
  return tail.length === 0 ? "***" : `***${tail}`;
}

/**
 * Dev adapter: doesn't send anything, it prints.
 *
 * Audit fix — this logged `{ phone, message }` at INFO, i.e. the full E.164 number AND the live
 * OTP in plaintext. Logs get shipped, tailed and retained far more widely than anyone reasons
 * about when writing a dev adapter, and an OTP in a log line is a *credential* in a log line:
 * whoever can read the log can complete someone's login.
 *
 * The number is now always masked, and the code-bearing body is only printed when
 * `config.allowDevRoutes` (development/test) — the same single switch that gates /dev/token,
 * because both are the same category of thing: a local convenience that is an authentication
 * bypass anywhere else. Note the gate has to be explicit rather than relying on a log level:
 * this codebase's logger emits every level unconditionally, so `logger.debug` is NOT quiet in
 * production. If this provider is ever misconfigured into a real deployment it degrades to a
 * masked "an OTP was requested" line and nothing usable.
 */
export class ConsoleSmsProvider implements SmsProvider {
  async send(phone: string, message: string): Promise<void> {
    logger.info("SMS (console sandbox — not delivered)", { phone: maskPhone(phone) });
    if (config.allowDevRoutes) {
      logger.debug("SMS body (console sandbox — contains the OTP, dev/test only)", {
        phone: maskPhone(phone),
        // `body`, not `message`/`code`: the logger redacts on key name, and a key it doesn't
        // recognise must not accidentally look safe — this line is deliberately gated above.
        body: message,
      });
    }
  }
}

/** Raised when the carrier rejects or fails to accept a message. Distinct from a programming
 *  error so the OTP service can tell "we could not send" (retryable, tell the user to try
 *  again) from "we sent it" — a user who is told a code is coming when none was sent will sit
 *  and wait indefinitely. */
export class SmsDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly providerCode?: string | number,
  ) {
    super(message);
    this.name = "SmsDeliveryError";
  }
}

/**
 * Twilio SMS delivery over the REST API.
 *
 * Uses `fetch` and the documented HTTP endpoint rather than the `twilio` npm package: the SDK
 * is a large dependency (and its own transitive tree) to gain one POST with basic auth. The
 * request shape here is `POST /2010-04-01/Accounts/{sid}/Messages.json`, form-encoded, which
 * has been stable for over a decade.
 *
 * Credentials come from config, which fails fast at boot if they are missing in production, so
 * this constructor can assume they are present rather than checking on every send.
 *
 * Not exercised against the live Twilio API in this repo — there are no credentials. What *is*
 * verified in tests is the part that would actually break: the request encoding, the basic-auth
 * header, error mapping, and that a non-2xx response raises rather than silently succeeding.
 * That last one is the whole reason this class exists instead of a stub: a provider that
 * swallows failures reports "code sent" to someone who will never receive it.
 */
export class TwilioSmsProvider implements SmsProvider {
  /** Injectable purely so tests can assert the exact request without network access. */
  constructor(
    private readonly opts: {
      accountSid: string;
      authToken: string;
      /** E.164 number or Messaging Service SID the message is sent from. */
      from: string;
      fetchImpl?: typeof fetch;
      /** Abort a hung request: an OTP that arrives after the user has given up is useless, and
       *  holding the HTTP handler open makes the whole endpoint a queue. */
      timeoutMs?: number;
    },
  ) {}

  async send(phone: string, message: string): Promise<void> {
    const { accountSid, authToken, from } = this.opts;
    const doFetch = this.opts.fetchImpl ?? fetch;
    const timeoutMs = this.opts.timeoutMs ?? 8_000;

    const body = new URLSearchParams({ To: phone, Body: message });
    // A Messaging Service SID and a plain number go in different fields.
    if (from.startsWith("MG")) body.set("MessagingServiceSid", from);
    else body.set("From", from);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            // Basic auth, per Twilio's REST contract. Built by hand rather than via a URL
            // userinfo component, which some fetch implementations strip.
            authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
          signal: controller.signal,
        },
      );

      if (!res.ok) {
        // Twilio returns a JSON error document; its `code` is far more diagnostic than the
        // status alone (21610 = recipient unsubscribed, 21211 = invalid number, …).
        const detail = (await res.json().catch(() => ({}))) as {
          message?: string;
          code?: number;
        };
        // Never log or attach the message body — it contains the OTP.
        logger.error("twilio rejected an SMS", {
          phone: maskPhone(phone),
          status: res.status,
          providerCode: detail.code,
        });
        throw new SmsDeliveryError(
          `twilio refused the message (status ${res.status}${detail.code ? `, code ${detail.code}` : ""})`,
          res.status,
          detail.code,
        );
      }

      logger.info("SMS dispatched", { phone: maskPhone(phone), provider: "twilio" });
    } catch (err) {
      if (err instanceof SmsDeliveryError) throw err;
      // An abort is a timeout; anything else is a transport failure. Both are "not delivered".
      const reason = (err as Error).name === "AbortError" ? "timed out" : "transport failure";
      logger.error("twilio SMS failed", { phone: maskPhone(phone), reason });
      throw new SmsDeliveryError(`twilio send ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

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
  /** Interpret an ALREADY-AUTHENTICATED provider callback into a decision, or null for anything
   *  it does not positively recognise. Authenticity (the HMAC over the raw body) and the subject
   *  (resolved from the server-issued nonce) are settled by the route before this is reached —
   *  see auth/router.ts. This only maps a trusted payload to a decision, and it must fail
   *  CLOSED while doing so. */
  interpretCallback(payload: unknown): { reference: string; decision: KycDecision } | null;
}

/**
 * Sandbox adapter: hands back a fake verification URL and accepts a simple callback shape.
 * Persists nothing raw — the caller stores only status + this opaque reference.
 *
 * Audit A5(b) — references used to be `sandbox_<userId>_<base36 Date.now()>`: fully derivable by
 * anyone who knew a userId and roughly when verification started. Combined with a callback that
 * trusted its own body, that let anybody verify themselves — or someone else — as a helper.
 * References are now 32 bytes of CSPRNG output containing no user data at all, and the
 * reference→userId binding lives server-side in Redis under `keys.kycNonce`.
 */
export class SandboxKycProvider implements KycProvider {
  async start(_userId: string): Promise<KycStartResult> {
    const reference = `sbx_${randomBytes(32).toString("base64url")}`;
    return { reference, verificationUrl: `https://sandbox.kyc.local/verify/${reference}` };
  }

  /**
   * Audit A5(d) — this FAILED OPEN: `p.decision === "rejected" ? "rejected" : "verified"`, so a
   * missing, misspelled, null or hostile `decision` all became a *verification*. A KYC seam that
   * defaults to "identity confirmed" is worse than no KYC at all, because everything downstream
   * treats `verified` as evidence that a real human was actually checked. It now fails CLOSED:
   * only the literal "verified" verifies, only "rejected" rejects, and anything else is refused
   * as unrecognised (route → 400) with the user's status left exactly as it was.
   */
  interpretCallback(payload: unknown): { reference: string; decision: KycDecision } | null {
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as { reference?: unknown; decision?: unknown };
    if (typeof p.reference !== "string" || p.reference.length === 0) return null;
    if (p.decision !== "verified" && p.decision !== "rejected") return null;
    return { reference: p.reference, decision: p.decision };
  }
}

// ── callback authenticity (audit A5a) ────────────────────────────────────────

/** Header the provider carries the HMAC in. Real providers each name this differently
 *  (`X-Signature`, `Stripe-Signature`, …), so the seam is one constant to re-point. */
export const KYC_SIGNATURE_HEADER = "x-needy-kyc-signature";

/** HMAC-SHA256, hex, over the RAW request body. The raw bytes are load-bearing: signing a
 *  re-serialised `req.body` would let an attacker vary key order, whitespace or duplicate keys
 *  and still hand us a body whose signature checks out but whose parse differs from ours. */
export function signKycCallback(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time comparison of the presented signature against the expected one. Lengths are
 *  compared first because `timingSafeEqual` throws on a length mismatch — and a length
 *  difference isn't the secret here, the byte contents are. */
export function verifyKycSignature(
  rawBody: Buffer | string,
  presented: string | undefined,
  secret: string,
): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const expected = Buffer.from(signKycCallback(rawBody, secret), "utf8");
  const actual = Buffer.from(presented.trim(), "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
