/** ── Service catalog ───────────────────────────────────────────────────────
 *  What a requester can ask for, and what a helper can offer.
 *
 *  The catalog lives in the database (admins can add to it) but these codes are referenced
 *  by name in matching, pricing and the UI, so the ones the product depends on are declared
 *  here and seeded by migration 4. A code that code branches on must not be free-form data.
 */

export const HOSPITAL_SERVICE_CODE = "hospital";

export interface ServiceDefinition {
  code: string;
  name: string;
  description: string;
  /**
   * Every helper offers this, and it cannot be opted out of.
   *
   * Exactly one service is mandatory: hospital accompaniment. It is the emergency path, so
   * the pool of available helpers for it must be the whole verified pool — a rota that
   * anyone can quietly leave is not an emergency service.
   */
  isMandatory: boolean;
  /**
   * Dispatched live, right now, the way a ride-hailing app does — no lead time.
   *
   * Note this is orthogonal to the eligibility matrix: an immediate service still cannot be
   * dispatched to a restricted pairing. What it means is that when a pairing IS allowed,
   * there is no waiting.
   */
  isImmediate: boolean;
  /** Flat price in whole rupees. 0 = volunteer. */
  basePrice: number;
}

/** Seeded by migration 4. Kept in code as the source of truth for the seed so a fresh
 *  database and a long-running one agree on what these codes mean. */
export const SEED_SERVICES: readonly ServiceDefinition[] = [
  {
    code: HOSPITAL_SERVICE_CODE,
    name: "Hospital visit",
    description:
      "Accompany someone to hospital or a clinic, including in an emergency. Every verified helper offers this.",
    isMandatory: true,
    isImmediate: true,
    basePrice: 299,
  },
  {
    code: "groceries",
    name: "Grocery & shopping",
    description: "Fetch groceries, medicines or run a shop errand.",
    isMandatory: false,
    isImmediate: true,
    basePrice: 149,
  },
  {
    code: "companion-walk",
    name: "Companion walk",
    description: "Company on a walk, or simply someone to sit and talk with.",
    isMandatory: false,
    isImmediate: true,
    basePrice: 199,
  },
  {
    code: "pick-deliver",
    name: "Pick & deliver",
    description: "Collect something from one place and take it to another.",
    isMandatory: false,
    isImmediate: true,
    basePrice: 149,
  },
  {
    code: "social-service",
    name: "Social service",
    description: "Volunteer help for someone who cannot afford to pay.",
    isMandatory: false,
    isImmediate: true,
    basePrice: 0,
  },
];

export function isMandatoryService(code: string): boolean {
  return SEED_SERVICES.some((s) => s.code === code && s.isMandatory);
}

/** The set every approved helper offers whether they chose it or not. Applied on approval
 *  and re-applied on every save, so opting out is not expressible through the API. */
export const MANDATORY_SERVICE_CODES: readonly string[] = SEED_SERVICES.filter(
  (s) => s.isMandatory,
).map((s) => s.code);
