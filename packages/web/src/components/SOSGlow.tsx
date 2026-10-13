"use client";

import { motion } from "framer-motion";
import { ReactNode } from "react";

/** DOM id of the alarm control on a task screen. The header's emergency button looks for it
 *  so that, on a task, it leads to the real alarm rather than to instructions. */
export const TASK_ALARM_ID = "task-alarm";

export function SOSGlow({ children, onClick }: { children: ReactNode, onClick?: () => void }) {
  return (
    <div className="relative inline-flex items-center justify-center">
      <motion.div
        className="absolute inset-0 rounded-full bg-red-500"
        animate={{
          scale: [1, 1.2, 1],
          opacity: [0.1, 0.3, 0.1],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
      <motion.button
        onClick={onClick}
        whileTap={{ scale: 0.95 }}
        className="relative z-10 flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-white shadow-lg transition-colors hover:bg-red-700 focus:outline-none focus:ring-4 focus:ring-red-500/50"
      >
        {children}
      </motion.button>
    </div>
  );
}
