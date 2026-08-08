/** ── Phone normalisation ───────────────────────────────────────────────────
 *  The backend stores and keys on E.164 (`+919876543210`) — it is the `phone` UNIQUE column,
 *  the OTP rate-limit bucket, and the input to the block-list HMAC. If the client sends
 *  "98765 43210" one day and "+91 98765 43210" the next, the same human gets two accounts and
 *  the per-phone OTP limiter is trivially sidestepped by re-typing the number differently.
 *
 *  So normalisation happens before every call, not in a form's onChange — a user pasting a
 *  number with spaces should not be corrected as they type.
 */

/** Default country. India-only today; this is the one place to change when that stops being
 *  true, rather than a `+91` sprinkled through the forms. */
const DEFAULT_COUNTRY_CODE = "91";

/**
 * Best-effort E.164. Strips spaces, hyphens and brackets, keeps a leading `+`, and prepends
 * the default country code to a bare 10-digit national number.
 *
 * Deliberately not a full libphonenumber: that is ~150 KB in the client bundle to validate
 * carrier prefixes the server's own regex does not check either. The server is the authority
 * on whether a number is acceptable; this just stops the same number arriving in two shapes.
 */
export function normalisePhone(input: string): string {
  const trimmed = input.trim();
  const hadPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");

  // `0` prefixes a national number in India (and much of the world) and is not part of the
  // E.164 form. Dropping it turns 09876543210 into the same key as +919876543210.
  if (!hadPlus && digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  if (hadPlus) return `+${digits}`;
  if (digits.length === 10) return `+${DEFAULT_COUNTRY_CODE}${digits}`;
  return `+${digits}`;
}

/**
 * A user-facing reason the number is unusable, or null if it looks fine.
 *
 * Mirrors the server's `phoneSchema` (`/^\+?[1-9]\d{7,14}$/`) so the form does not accept
 * something the API will reject a round trip later. The server remains the authority — this
 * is a courtesy, not a gate.
 */
export function phoneError(input: string): string | null {
  if (input.trim() === "") return "Enter your mobile number.";
  const e164 = normalisePhone(input);
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
    return "That doesn't look like a valid mobile number.";
  }
  return null;
}
