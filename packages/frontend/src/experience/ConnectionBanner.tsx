import { AnimatePresence, motion } from "framer-motion";
import type { ConnectionState } from "../realtime/index.js";

/** Reconnect is a first-class, visible state (§2.1) — the app never silently pretends it's
 *  live during a drop. Shown as a calm strip, not an alarming error. */
const COPY: Partial<Record<ConnectionState, string>> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting — hold on, we haven't lost your helper",
  resyncing: "Catching up on what happened while you were away…",
};

export function ConnectionBanner({ connection }: { connection: ConnectionState }) {
  const text = COPY[connection];
  return (
    <AnimatePresence>
      {text && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3 }}
          style={{
            textAlign: "center",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--needy-text)",
            background: "rgba(127,169,214,.16)",
            border: "1px solid rgba(127,169,214,.3)",
            borderRadius: 999,
            padding: "7px 16px",
            margin: "0 auto 12px",
            width: "fit-content",
          }}
          role="status"
        >
          {text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
