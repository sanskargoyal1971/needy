/**
 * The single source of truth for Needy's motion feel (§4). Every animation in the
 * vocabulary reads its pacing, easing and accent colors from here — never hard-coded in a
 * component — so the whole app can be re-tuned from one place as it grows past MVP.
 *
 * Design intent: warm, slow, "living/breathing". Motion should read as a calm human
 * presence, not a busy machine. When in doubt, slow it down and soften it.
 */

/** Durations in SECONDS (Framer Motion's native unit for tween `duration`). */
export const duration = {
  /** One full inhale→exhale of a breathing element. Deliberately slow. */
  breath: 3.2,
  /** One radar pulse traveling from center to edge (§3 Stage 1). */
  radarSweep: 3.6,
  /** A "someone walked up to greet you" entrance (§3 Stage 2). */
  reveal: 0.9,
  /** One cycle of the three typing dots (§3 Stage 6). */
  typingCycle: 1.3,
  /** The arrival bloom (§3 Stage 5). */
  arrival: 1.1,
  /** Default window to interpolate a marker between two GPS points (§2.3 / §3 Stage 4).
   *  Matches the 3–5s location cadence; the marker should still be moving when the next
   *  point lands, so motion never visibly stops. */
  markerTween: 4,
} as const;

/** Cubic-bezier easing curves, named by feel. Framer Motion accepts the 4-tuple form. */
export const ease = {
  /** Sinusoidal in-out — the core "breathing" curve, symmetric and gentle. */
  breathe: [0.37, 0, 0.63, 1],
  /** Soft settle with a hint of overshoot damping — an arrival, not a pop. */
  arrive: [0.16, 1, 0.3, 1],
  /** General soft ease for reveals and cross-fades. */
  soft: [0.4, 0, 0.2, 1],
  /** Near-linear, for continuous travel (interpolated marker) so it never "eases to a stop"
   *  mid-journey between points. */
  travel: [0.4, 0.0, 0.6, 1.0],
} as const;

/** Spring presets for the few places a spring reads more alive than a tween. */
export const spring = {
  /** Gentle greeting spring for the match reveal card. */
  greet: { type: "spring", stiffness: 140, damping: 18, mass: 1 },
  /** Firm, unmistakable spring for the SOS escalation (§3 Stage 6). */
  alarm: { type: "spring", stiffness: 320, damping: 14, mass: 0.9 },
} as const;

/**
 * Accent colors that DRIVE animation (glows, sweeps, blooms). Surface/text theming lives in
 * CSS variables (styles.css); these are the few hues motion reaches for directly. Warm and
 * human — the presence green signals "a person is available", the warm amber signals care,
 * the alarm red is reserved exclusively for SOS so it can never be confused with anything else.
 */
export const color = {
  warm: "#E8935A", //        care / helper accent
  warmSoft: "#F4C79B", //    warm halo
  presence: "#5FB98E", //    online-available / radar
  presenceSoft: "#A7DCC4",
  calm: "#7FA9D6", //        connecting / verifying
  alarm: "#E5484D", //       SOS ONLY — never reuse
} as const;

export type MotionColor = keyof typeof color;

/** Resolve a color token (or pass a raw CSS color straight through). Components accept a
 *  `MotionColor` token by default but stay escape-hatchable for one-offs. */
export function resolveColor(token: MotionColor | (string & {})): string {
  return (color as Record<string, string>)[token] ?? token;
}

/** Intensity presets — a normalized 0–1 knob components map onto their own scale/opacity
 *  ranges, so "subtle vs bold" is consistent language across the vocabulary. */
export const intensity = {
  subtle: 0.35,
  base: 0.6,
  bold: 1,
} as const;

export type IntensityPreset = keyof typeof intensity;

export function resolveIntensity(value: IntensityPreset | number): number {
  const n = typeof value === "number" ? value : intensity[value];
  return Math.min(1, Math.max(0, n));
}

export const motionConfig = {
  duration,
  ease,
  spring,
  color,
  intensity,
} as const;
