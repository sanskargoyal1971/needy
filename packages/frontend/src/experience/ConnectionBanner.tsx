import { AnimatePresence, motion } from "framer-motion";
import type { ConnectionState } from "../realtime/index.js";

/** Reconnect is a first-class, visible state (§2.1) — the app never silently pretends it's
 *  live during a drop. Shown as a calm strip, not an alarming error.
 *
 *  `offline` was missing here (audit C22): the state existed in the type, so if anything ever
 *  set it the banner rendered an empty strip — a blank bar during the one moment the user most
 *  needs to be told what's happening. It's now covered, and deliberately worded differently
 *  from `reconnecting`: we are NOT retrying on our own, so the copy has to say what the user
 *  can do rather than ask them to keep waiting. `online` stays absent on purpose — when
 *  everything is fine there is nothing to say. */
const COPY: Partial<Record<ConnectionState, string>> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting — hold on, we haven't lost your helper",
  resyncing: "Catching up on what happened while you were away…",
  offline: "You're not connected right now. Check your internet, and we'll pick up right here.",
};

/** `offline` is the only state that isn't self-healing, so it gets a warmer, more urgent
 *  tint than the calm blue used while we're merely catching up. */
const TONE: Partial<Record<ConnectionState, { bg: string; border: string }>> = {
  offline: { bg: "rgba(232,147,90,.16)", border: "rgba(232,147,90,.34)" },
};
const DEFAULT_TONE = { bg: "rgba(127,169,214,.16)", border: "rgba(127,169,214,.3)" };

export function ConnectionBanner({ connection }: { connection: ConnectionState }) {
  const text = COPY[connection];
  const tone = TONE[connection] ?? DEFAULT_TONE;
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
            background: tone.bg,
            border: `1px solid ${tone.border}`,
            borderRadius: 999,
            padding: "7px 16px",
            margin: "0 auto 12px",
            maxWidth: "100%",
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
