"use client";

import { useRef } from "react";
import { motion } from "framer-motion";
import { useDepthMotion } from "@/motion/depth";

/**
 * The slow gradient behind the landing hero. It shares the 3D objects' motion state rather
 * than looping on its own: an endless 10s breath ran under reduced motion and off screen,
 * and on the landing page it is the first moving thing anyone sees.
 */
export function BreathingBackground({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useDepthMotion(ref);
  const running = state === "running";

  return (
    <div ref={ref} data-motion={state} className={`relative overflow-hidden ${className}`}>
      <motion.div
        aria-hidden
        className="absolute inset-0 z-0 bg-gradient-to-br from-background via-[#e2ebea] to-background opacity-50"
        initial={false}
        // At rest it holds the middle of the breath, so stopping looks like a pause, not a
        // jump to its faintest or strongest.
        animate={
          running ? { scale: [1, 1.05, 1], opacity: [0.3, 0.6, 0.3] } : { scale: 1, opacity: 0.45 }
        }
        transition={
          running
            ? { duration: 10, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }
            : { duration: 0.8, ease: "easeOut" }
        }
      />
      <div className="relative z-10 h-full w-full">{children}</div>
    </div>
  );
}
