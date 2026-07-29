import { motion } from "framer-motion";
import type { CSSProperties, ReactNode } from "react";
import { duration as D, ease as E } from "./motion.config.js";
import { useReducedMotionPref } from "./preferences.js";

export interface SoftScaleRevealProps {
  children: ReactNode;
  /** Seconds for the reveal. Defaults to the shared reveal tempo. */
  duration?: number;
  /** Delay before the reveal begins (e.g. to sequence after a radar hand-off). */
  delay?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * The arrival-of-a-person entrance (§3 Stage 2). Content scales up softly from 96% with a
 * single gentle "breath" of overshoot and a fade — timed like someone walking up to greet
 * you, NOT a data card populating or a hard pop-in. Use it for the match-found reveal, and
 * anywhere a real person's information should feel like it *arrived* rather than *loaded*.
 *
 * Reduced motion: a plain, quick cross-fade with no scale movement.
 */
export function SoftScaleReveal({
  children,
  duration = D.reveal,
  delay = 0,
  className,
  style,
}: SoftScaleRevealProps) {
  const reduced = useReducedMotionPref();

  if (reduced) {
    return (
      <motion.div
        className={className}
        style={style}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2, ease: E.soft, delay }}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div
      className={className}
      style={style}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{
        opacity: 1,
        // keyframed scale: settle just past 1, then ease back — the "breath".
        scale: [0.96, 1.015, 1],
      }}
      transition={{
        duration,
        ease: E.arrive,
        delay,
        opacity: { duration: duration * 0.7, ease: E.soft, delay },
      }}
    >
      {children}
    </motion.div>
  );
}
