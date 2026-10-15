/** ── Phone normalisation ───────────────────────────────────────────────────
 *  One canonical form, E.164 (`+919876543210`), for the same number however it was typed.
 *  The account lookup, the OTP rate-limit bucket and the block list are all keyed on it, so
 *  "98765 43210", "919876543210" and "+91 98765 43210" have to land on the same key or the
 *  same person gets several accounts and a blocked number comes back in another shape.
 *
 *  Shared so the server applies exactly what the forms do. It used to live in the web app
 *  only, and the API accepted any shape its regex allowed: a client that skipped the form
 *  (or a staff number typed without +91) made a second account for an existing person.
 */

/** Default country. India-only today; this is the one place to change when that stops being
 *  true, rather than a `+91` sprinkled through the code. */
export const DEFAULT_COUNTRY_CODE = "91";

/** What a canonical number looks like. */
export const PHONE_E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Best-effort E.164. Strips spaces, hyphens and brackets, keeps a leading `+`, drops a national
 * trunk `0`, and prepends the default country code to a bare 10-digit national number.
 * Idempotent: a canonical number comes back unchanged.
 *
 * Deliberately not a full libphonenumber: that is ~150 KB in the client bundle to validate
 * carrier prefixes nothing here relies on. It only has to make one number arrive in one shape.
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
