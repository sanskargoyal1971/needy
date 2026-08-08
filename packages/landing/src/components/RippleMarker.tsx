"use client";

import { motion } from "framer-motion";

export function RippleMarker({ size = 24 }: { size?: number }) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <motion.div
        className="absolute rounded-full border-2 border-primary"
        style={{ width: size, height: size }}
        animate={{
          scale: [1, 2, 3],
          opacity: [1, 0.5, 0],
        }}
        transition={{
          duration: 2,
          repeat: Infinity,
          ease: "easeOut",
        }}
      />
      <div className="relative rounded-full bg-primary" style={{ width: size * 0.4, height: size * 0.4 }} />
    </div>
  );
}
