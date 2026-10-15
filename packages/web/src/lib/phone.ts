/** ── Phone normalisation ───────────────────────────────────────────────────
 *  The canonical form and the function that produces it live in @needy/shared, so the forms
 *  and the API agree on what "the same number" is. See shared/src/phone.ts.
 *
 *  Normalisation happens before every call, not in a form's onChange — a user pasting a
 *  number with spaces should not be corrected as they type.
 */
import { normalisePhone, PHONE_E164 } from "@needy/shared";

export { normalisePhone };

/**
 * A user-facing reason the number is unusable, or null if it looks fine.
 *
 * Checks the canonical form against the same pattern the server enforces, so the form does
 * not accept something the API will reject a round trip later. The server remains the
 * authority — this is a courtesy, not a gate.
 */
export function phoneError(input: string): string | null {
  if (input.trim() === "") return "Enter your mobile number.";
  if (!PHONE_E164.test(normalisePhone(input))) {
    return "That doesn't look like a valid mobile number.";
  }
  return null;
}
