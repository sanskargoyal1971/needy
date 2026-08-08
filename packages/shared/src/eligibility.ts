import type { Gender } from "./onboarding.js";

/** ── Who may be matched with whom ──────────────────────────────────────────
 *  A safety rule, not a preference filter. Both sides import this: the backend refuses to
 *  offer a task to an ineligible helper, and the UI explains why a pairing needs an
 *  exception. Same file, same function — the precedent set by `authz.ts`, for the same
 *  reason: "the UI hid it" and "the server refused" must be one rule rather than two that
 *  drift apart.
 *
 *  The policy, as specified:
 *   - A senior (60+) requester may book anyone.
 *   - An adult (36–59) requester may book anyone.
 *   - Between two YOUNG adults (18–35) of DIFFERENT gender, a booking requires an approved
 *     exception — in both directions, symmetrically.
 *   - Under 18 cannot participate at all.
 *
 *  The symmetry is deliberate and was confirmed as the intent. It is also the only reading
 *  that is coherent: a rule protecting one gender but not the other would leave the second
 *  party's safety resting on the first party's good behaviour.
 */

/** Bands are derived from date of birth at evaluation time, never stored. A stored band is
 *  wrong the morning after someone's 36th birthday, and this rule is the last place you want
 *  a value that silently goes stale. */
export type AgeBand = "minor" | "young" | "adult" | "senior";

/** Inclusive lower bounds, highest first — the order `ageBand` scans them in. */
export const AGE_BANDS: readonly { band: AgeBand; minAge: number }[] = [
  { band: "senior", minAge: 60 },
  { band: "adult", minAge: 36 },
  { band: "young", minAge: 18 },
  { band: "minor", minAge: 0 },
];

/**
 * Whole years elapsed, by calendar.
 *
 * NOT `(now - dob) / 365.25 days`: that drifts by a day or more across leap years and puts
 * people on the wrong side of a birthday — which here means the wrong side of a band
 * boundary, and therefore a different answer about who they may be matched with.
 */
export function ageInYears(dobISO: string, nowMs: number): number {
  const dob = new Date(`${dobISO}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return Number.NaN;
  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export function ageBand(dobISO: string, nowMs: number): AgeBand {
  const age = ageInYears(dobISO, nowMs);
  // An unparseable date is treated as a minor, i.e. the most restrictive band. Fail closed:
  // a bad date must never widen who someone can be matched with.
  if (Number.isNaN(age)) return "minor";
  return AGE_BANDS.find((b) => age >= b.minAge)!.band;
}

/** The identity facts a pairing decision needs. Deliberately the minimum — this function is
 *  handed slices of user records, never whole ones, so it cannot come to depend on anything
 *  a caller might not have. */
export interface PairingParty {
  dateOfBirth: string | null;
  gender: Gender | null;
}

export type PairingDecision =
  /** Book immediately, live dispatch. */
  | { kind: "allowed" }
  /** Legal, but only after both parties record a video testimony and an admin approves it.
   *  Because that review takes up to a working day, such bookings are scheduled in advance
   *  rather than dispatched live. */
  | { kind: "requires-exception"; reason: string }
  /** Never permitted, and no exception can unlock it. */
  | { kind: "denied"; reason: string };

/** Only male↔female pairings carry the restriction. `other` is not treated as either side of
 *  it: the rule exists to address a specific safety concern between young men and young
 *  women, and stretching it to cover a third value would be inventing policy rather than
 *  implementing it. Flagged here so the choice is visible rather than incidental. */
const RESTRICTED_GENDERS: readonly Gender[] = ["male", "female"];

/**
 * May `requester` book `helper`?
 *
 * Evaluated in order; the first matching rule wins. Every branch either denies or explains,
 * so a caller never has to infer why.
 */
export function pairingDecision(
  requester: PairingParty,
  helper: PairingParty,
  nowMs: number,
): PairingDecision {
  // Fail closed on incomplete identity. An account cannot reach `approved` without a date of
  // birth and a gender, so this is unreachable in normal operation — but "unreachable" is
  // exactly the assumption that stops being true, and the safe answer is no.
  if (!requester.dateOfBirth || !requester.gender) {
    return { kind: "denied", reason: "your profile is missing details we need" };
  }
  if (!helper.dateOfBirth || !helper.gender) {
    return { kind: "denied", reason: "this helper's profile is incomplete" };
  }

  const requesterBand = ageBand(requester.dateOfBirth, nowMs);
  const helperBand = ageBand(helper.dateOfBirth, nowMs);

  if (requesterBand === "minor") {
    return { kind: "denied", reason: "Needy is for adults only" };
  }
  if (helperBand === "minor") {
    return { kind: "denied", reason: "this helper is not eligible" };
  }

  const bothYoung = requesterBand === "young" && helperBand === "young";
  const bothRestrictedGenders =
    RESTRICTED_GENDERS.includes(requester.gender) && RESTRICTED_GENDERS.includes(helper.gender);
  const differentGender = requester.gender !== helper.gender;

  if (bothYoung && bothRestrictedGenders && differentGender) {
    return {
      kind: "requires-exception",
      reason:
        "For safety, bookings between adults under 36 of different genders need a one-time verification by our team.",
    };
  }

  return { kind: "allowed" };
}

/** Convenience for the matching filter, which only cares whether an offer may go out now.
 *  A `requires-exception` pairing is NOT live-dispatchable — it becomes bookable only as a
 *  scheduled task once an exception has been approved. */
export function isLiveDispatchable(decision: PairingDecision): boolean {
  return decision.kind === "allowed";
}

// ── scheduling ───────────────────────────────────────────────────────────────

/**
 * Minimum lead time for an exception-gated booking.
 *
 * This is the ONLY reason advance booking exists. Ordinary pairings dispatch live, the way a
 * ride-hailing app does; a restricted pairing needs a human to watch two video testimonies
 * first, and that review is promised within one working day. Booking at least a day out is
 * what makes the promise keepable rather than a queue the requester waits on in real time.
 */
export const EXCEPTION_REVIEW_SLA_MS = 24 * 60 * 60 * 1000;

/** How far ahead a scheduled booking may be placed. A bound exists so the exception's
 *  approval and the booking it unlocks stay close enough together that the review is still
 *  meaningful. */
export const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

export type ScheduleProblem = "too-soon" | "too-far" | "in-the-past";

/** Validate a requested `scheduledFor` against the lead time. Returns null when acceptable. */
export function scheduleProblem(scheduledFor: number, nowMs: number): ScheduleProblem | null {
  if (scheduledFor <= nowMs) return "in-the-past";
  if (scheduledFor - nowMs < EXCEPTION_REVIEW_SLA_MS) return "too-soon";
  if (scheduledFor - nowMs > MAX_SCHEDULE_AHEAD_MS) return "too-far";
  return null;
}
