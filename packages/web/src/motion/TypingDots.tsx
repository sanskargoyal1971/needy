"use client";

import { motion } from "framer-motion";
import type { CSSProperties } from "react";
import { duration as D, ease as E, resolveColor, type MotionColor } from "./motion.config.js";
import { useReducedMotionPref } from "./preferences.js";

export interface TypingDotsProps {
  /** Dot color token. */
  color?: MotionColor | (string & {});
  /** Dot diameter in px. */
  size?: number;
  /** How many dots (default 3). */
  count?: number;
  /** Seconds for one full cycle across all dots. */
  duration?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * The "someone is typing" indicator (§3 Stage 6). Three soft dots on a gentle breathing
 * scale — the SAME breath curve as the rest of the app, so the motion vocabulary stays
 * consistent instead of introducing a new bounce per screen. A live typing indicator does a
 * lot of "a real person is here" work; it's not decoration.
 *
 * Reduced motion: three still dots at a calm mid-opacity (present, not animated).
 */
export function TypingDots({
  color = "warm",
  size = 9,
  count = 3,
  duration = D.typingCycle,
  className,
  style,
}: TypingDotsProps) {
  const reduced = useReducedMotionPref();
  const hue = resolveColor(color);
  const dots = Array.from({ length: count });

  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    background: hue,
  };

  return (
    <div
      className={className}
      style={{ display: "inline-flex", gap: size * 0.7, alignItems: "center", ...style }}
      role="status"
      aria-label="typing"
    >
      {dots.map((_, i) =>
        reduced ? (
          <span key={i} style={{ ...base, opacity: 0.55 }} />
        ) : (
          <motion.span
            key={i}
            style={base}
            initial={{ scale: 0.7, opacity: 0.45 }}
            animate={{ scale: [0.7, 1, 0.7], opacity: [0.45, 1, 0.45] }}
            transition={{
              duration,
              ease: E.breathe,
              repeat: Infinity,
              delay: (duration / (count * 2)) * i,
            }}
          />
        ),
      )}
    </div>
  );
}
