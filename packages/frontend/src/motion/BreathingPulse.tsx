import { motion } from "framer-motion";
import type { CSSProperties, ReactNode } from "react";
import {
  duration as D,
  ease as E,
  resolveColor,
  resolveIntensity,
  type IntensityPreset,
  type MotionColor,
} from "./motion.config.js";
import { useReducedMotionPref } from "./preferences.js";

export interface BreathingPulseProps {
  /** Diameter in px of the pulsing halo. */
  size?: number;
  /** Accent color token (or raw CSS color) for the glow. */
  color?: MotionColor | (string & {});
  /** How pronounced the breath is: preset name or a 0–1 number. Maps to scale + opacity. */
  intensity?: IntensityPreset | number;
  /** Seconds for one full inhale→exhale. Defaults to the shared breath tempo. */
  duration?: number;
  /** Optional content centered inside the halo (e.g. an SOS button, an avatar). */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * The foundational "alive" motion (§4). A soft radial glow that scales and brightens on a
 * slow, symmetric breath — the shared heartbeat every other component's timing echoes.
 * Compose it behind the SOS button (idle glow), a connecting avatar, or anywhere a surface
 * should feel inhabited rather than static.
 *
 * Reduced motion: renders a still, soft glow at rest — present but not moving.
 */
export function BreathingPulse({
  size = 96,
  color = "warm",
  intensity = "base",
  duration = D.breath,
  children,
  className,
  style,
}: BreathingPulseProps) {
  const reduced = useReducedMotionPref();
  const hue = resolveColor(color);
  const amt = resolveIntensity(intensity);
  const scaleTo = 1 + amt * 0.18; //         up to +18% at full intensity
  const glow = 0.18 + amt * 0.34; //         resting → peak halo opacity

  const halo: CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: "50%",
    background: `radial-gradient(circle, ${hue} 0%, transparent 68%)`,
    pointerEvents: "none",
  };

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: size,
        height: size,
        display: "grid",
        placeItems: "center",
        ...style,
      }}
    >
      {reduced ? (
        <div style={{ ...halo, opacity: glow * 0.8 }} />
      ) : (
        <motion.div
          style={halo}
          initial={{ scale: 1, opacity: glow * 0.55 }}
          animate={{ scale: [1, scaleTo, 1], opacity: [glow * 0.55, glow, glow * 0.55] }}
          transition={{ duration, ease: E.breathe, repeat: Infinity }}
        />
      )}
      {children != null && (
        <div style={{ position: "relative", zIndex: 1, display: "grid", placeItems: "center" }}>
          {children}
        </div>
      )}
    </div>
  );
}
