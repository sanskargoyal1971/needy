import { motion } from "framer-motion";
import type { CSSProperties } from "react";
import {
  duration as D,
  ease as E,
  resolveColor,
  type MotionColor,
} from "./motion.config.js";
import { useReducedMotionPref } from "./preferences.js";

/** A helper found nearby, placed on the radar by normalized offset from center.
 *  `x`/`y` are in [-1, 1] (0,0 = center); `delay` staggers their soft fade-in. */
export interface RadarBlip {
  id: string;
  x: number;
  y: number;
  delay?: number;
}

export interface RadarSweepProps {
  /** Diameter in px. */
  size?: number;
  /** Accent color token — defaults to the presence green ("real people nearby"). */
  color?: MotionColor | (string & {});
  /** Seconds for one pulse to travel center→edge. */
  pulseDuration?: number;
  /** How many concentric pulses are in flight at once (staggered). */
  ringCount?: number;
  /** Real helpers found nearby — their silhouettes fade in on the radar (§3 Stage 1). */
  blips?: RadarBlip[];
  className?: string;
  style?: CSSProperties;
}

/**
 * The "searching" animation (§3 Stage 1). Concentric rings expand outward from the user's
 * position like reaching into the neighborhood — NOT a spinner. As real helpers are found,
 * pass them as `blips` and their silhouettes fade in at their approximate positions,
 * reinforcing "there are real people around you," not "the system is thinking."
 *
 * Reduced motion: static concentric rings + statically-placed blips, no expansion.
 */
export function RadarSweep({
  size = 240,
  color = "presence",
  pulseDuration = D.radarSweep,
  ringCount = 3,
  blips = [],
  className,
  style,
}: RadarSweepProps) {
  const reduced = useReducedMotionPref();
  const hue = resolveColor(color);
  const rings = Array.from({ length: ringCount });
  const radius = size / 2;

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        ...style,
      }}
    >
      {/* Expanding pulses */}
      {rings.map((_, i) =>
        reduced ? (
          <div
            key={i}
            style={{
              position: "absolute",
              width: `${((i + 1) / ringCount) * 100}%`,
              height: `${((i + 1) / ringCount) * 100}%`,
              borderRadius: "50%",
              border: `1px solid ${hue}`,
              opacity: 0.18 + (0.32 * (ringCount - i)) / ringCount,
            }}
          />
        ) : (
          <motion.div
            key={i}
            style={{
              position: "absolute",
              width: size,
              height: size,
              borderRadius: "50%",
              border: `1.5px solid ${hue}`,
            }}
            initial={{ scale: 0.12, opacity: 0.5 }}
            animate={{ scale: 1, opacity: 0 }}
            transition={{
              duration: pulseDuration,
              ease: E.soft,
              repeat: Infinity,
              delay: (pulseDuration / ringCount) * i,
            }}
          />
        ),
      )}

      {/* Center point — "you" */}
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: hue,
          boxShadow: `0 0 12px ${hue}`,
        }}
      />

      {/* Helper silhouettes fading in at their approximate positions */}
      {blips.map((b) => {
        const left = radius + b.x * radius * 0.82;
        const top = radius + b.y * radius * 0.82;
        const dot = (
          <span
            style={{
              display: "block",
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: hue,
              opacity: 0.9,
              boxShadow: `0 0 10px ${hue}`,
            }}
          />
        );
        return reduced ? (
          <div key={b.id} style={{ position: "absolute", left, top, transform: "translate(-50%,-50%)" }}>
            {dot}
          </div>
        ) : (
          <motion.div
            key={b.id}
            style={{ position: "absolute", left, top, transform: "translate(-50%,-50%)" }}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, ease: E.soft, delay: b.delay ?? 0 }}
          >
            {dot}
          </motion.div>
        );
      })}
    </div>
  );
}
