"use client";

import { useRef, type ReactNode } from "react";
import { motion } from "framer-motion";
import { IDLE_SECONDS } from "./DepthStage.js";
import { useDepthMotion } from "./useDepthMotion.js";

export interface FloatProps {
  children?: ReactNode;
  /** Peak rise in px. Keep it small: this is a breath, not a bounce. */
  amplitude?: number;
  /** Seconds per cycle; defaults to the shared idle tempo. */
  duration?: number;
  /** Seconds to offset the cycle against a neighbour. */
  delay?: number;
  /** Hide from assistive technology. True for illustrations and backdrop blobs. */
  decorative?: boolean;
  className?: string;
}

/**
 * A slow vertical drift for flat things that sit around the 3D objects: the soft colour
 * blobs behind a hero, an illustrative card beside a pin. It replaces the `animate-float`
 * utility those used, which ran a 6s loop forever — under reduced motion, and off screen —
 * because a CSS class has no way to know either.
 */
export function Float({
  children,
  amplitude = 10,
  duration = IDLE_SECONDS,
  delay = 0,
  decorative = false,
  className,
}: FloatProps) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useDepthMotion(ref);
  const running = state === "running";

  return (
    <motion.div
      ref={ref}
      aria-hidden={decorative ? true : undefined}
      data-motion={state}
      className={className}
      initial={false}
      animate={running ? { y: [0, -amplitude, 0] } : { y: 0 }}
      transition={
        running
          ? { duration, ease: "easeInOut", repeat: Infinity, delay }
          : { duration: 0.8, ease: "easeOut" }
      }
    >
      {children}
    </motion.div>
  );
}
