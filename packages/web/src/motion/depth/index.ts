/**
 * Needy's 3D objects. Each is a set of CSS-3D faces on the shared `DepthStage`, which owns all
 * of their motion (entrance on scroll, slow idle loop, pointer tilt, pausing off screen, and
 * the still fallback under reduced motion). Pages compose these; they never add their own
 * keyframes for decoration.
 */
export { DepthStage, useStageMotion, CANVAS, IDLE_SECONDS } from "./DepthStage.js";
export type { DepthStageProps } from "./DepthStage.js";
export { useDepthMotion } from "./useDepthMotion.js";
export type { DepthMotionState } from "./useDepthMotion.js";
export { Float } from "./Float.js";
export type { FloatProps } from "./Float.js";
export { VerifiedShield3D } from "./VerifiedShield3D.js";
export type { DepthObjectProps } from "./VerifiedShield3D.js";
export { MapPin3D } from "./MapPin3D.js";
export { Doorstep3D } from "./Doorstep3D.js";
export { IconTile3D } from "./IconTile3D.js";
export type { IconTile3DProps } from "./IconTile3D.js";
