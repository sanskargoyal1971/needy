"use client";

import { motion } from "framer-motion";

export function PulseIndicator({
  size = 12,
  color = "bg-accent",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <motion.div
        className={`absolute rounded-full ${color}`}
        style={{ width: size, height: size }}
        animate={{
          scale: [1, 1.8, 2.2],
          opacity: [0.6, 0.2, 0],
        }}
        transition={{
          duration: 2.5,
          repeat: Infinity,
          ease: "easeOut",
        }}
      />
      <div
        className={`relative rounded-full ${color}`}
        style={{ width: size * 0.75, height: size * 0.75 }}
      />
    </div>
  );
}
