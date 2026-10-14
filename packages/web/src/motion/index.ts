/**
 * Needy's motion vocabulary (§4). Every stage-specific animation in the app composes from
 * these six primitives + the shared config, rather than introducing one-off motion per
 * screen. Built and tuned in isolation (see the playground) before being wired to live data
 * in Phase 3.
 */
export * from "./motion.config.js";
export * from "./preferences.js";
export { BreathingPulse } from "./BreathingPulse.js";
export type { BreathingPulseProps } from "./BreathingPulse.js";
export { RadarSweep } from "./RadarSweep.js";
export type { RadarSweepProps, RadarBlip } from "./RadarSweep.js";
export { SoftScaleReveal } from "./SoftScaleReveal.js";
export type { SoftScaleRevealProps } from "./SoftScaleReveal.js";
export { InterpolatedMarker } from "./InterpolatedMarker.js";
export type { InterpolatedMarkerProps } from "./InterpolatedMarker.js";
export { TypingDots } from "./TypingDots.js";
export type { TypingDotsProps } from "./TypingDots.js";
export { ArrivalHighlight } from "./ArrivalHighlight.js";
export type { ArrivalHighlightProps } from "./ArrivalHighlight.js";
export * from "./depth/index.js";
