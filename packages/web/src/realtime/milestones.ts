import type { MatchedHelper } from "@needy/shared";

/** Thresholds (seconds) that each fire one warm, human confirmation as the helper approaches
 *  (§3 Stage 4) — "small confirmations that a real person is progressing, not silence until
 *  arrival." Ordered high→low; a crossing fires when ETA drops from above to at/below one. */
const THRESHOLDS = [600, 300, 120, 60] as const;

function label(seconds: number, name: string): string {
  // Not "has arrived": this fires from an ETA, while the helper is still on the way. Arrival
  // is a state the helper declares, and it has its own screen.
  if (seconds <= 60) return `${name} is about a minute away`;
  return `${name} is ${Math.round(seconds / 60)} min away`;
}

/**
 * Returns a milestone string when the new ETA crosses a threshold the previous ETA was still
 * above (so each fires exactly once), else null. `prev` is null on the first ETA.
 */
export function nextMilestone(
  prevEtaSeconds: number | null,
  nextEtaSeconds: number,
  helper: MatchedHelper | null,
): string | null {
  const name = helper?.displayName ?? "Your helper";
  // The NEAREST threshold crossed, not the first in the list. Walking high→low and returning
  // on the first hit announced "10 min away" for a helper whose first ETA was two minutes —
  // which is every reload mid-journey, since `prev` starts null.
  let nearest: number | null = null;
  for (const t of THRESHOLDS) {
    const crossed = nextEtaSeconds <= t && (prevEtaSeconds === null || prevEtaSeconds > t);
    if (crossed) nearest = t;
  }
  return nearest === null ? null : label(nearest, name);
}
