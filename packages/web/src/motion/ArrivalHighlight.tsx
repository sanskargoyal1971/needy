"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState, type CSSProperties, type ReactNode } from "react";
import { duration as D, ease as E, resolveColor, type MotionColor } from "./motion.config.js";
import { useReducedMotionPref } from "./preferences.js";

export interface ArrivalHighlightProps {
  /** Rising edge triggers one bloom. Hold it true to keep a soft resting glow afterward. */
  active: boolean;
  /** Glow color token — warm by default (a caring arrival, not an alert). */
  color?: MotionColor | (string & {});
  /** Seconds for the bloom. */
  duration?: number;
  /** Fires once the bloom settles — e.g. to reveal the "Priya is here" label. */
  onArrived?: () => void;
  /** Content being highlighted; the bloom renders behind/over it, never blocking taps. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * The arrival moment (§3 Stage 5). A gentle, calm full-container warm bloom that makes it
 * unmistakable a real person has actually arrived — deliberately soft, never jarring, since
 * certainty here matters most for elderly/vulnerable users. Pair with a clear "Priya is here"
 * state and (optionally) a user-toggleable chime handled by the caller.
 *
 * Reduced motion: an instant, steady soft tint — unambiguous, with no bloom motion.
 */
export function ArrivalHighlight({
  active,
  color = "warm",
  duration = D.arrival,
  onArrived,
  children,
  className,
  style,
}: ArrivalHighlightProps) {
  const reduced = useReducedMotionPref();
  const hue = resolveColor(color);

  // Re-key each rising edge so the bloom replays even if `active` stays true.
  const [burst, setBurst] = useState(0);
  const [wasActive, setWasActive] = useState(active);
  // Adjusted during render, not in an effect: the effect rendered once with the old burst and
  // then again with the new one. React applies a render-time update before committing.
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setBurst((n) => n + 1);
  }

  const overlayBase: CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    pointerEvents: "none",
    background: `radial-gradient(circle at 50% 50%, ${hue} 0%, transparent 70%)`,
  };

  return (
    <div className={className} style={{ position: "relative", borderRadius: 16, ...style }}>
      {active &&
        (reduced ? (
          <div style={{ ...overlayBase, opacity: 0.16 }} />
        ) : (
          <AnimatePresence>
            <motion.div
              key={burst}
              style={overlayBase}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: [0, 0.42, 0.14], scale: [0.85, 1.04, 1] }}
              transition={{ duration, ease: E.arrive, times: [0, 0.55, 1] }}
              onAnimationComplete={() => onArrived?.()}
            />
          </AnimatePresence>
        ))}
      <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
    </div>
  );
}
