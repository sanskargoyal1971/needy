import { AnimatePresence, motion } from "framer-motion";
import { useHelperExperience } from "../realtime/index.js";
import { ConnectionBanner } from "../experience/ConnectionBanner.js";
import { AvailabilityPanel } from "./AvailabilityPanel.js";
import { OfferList } from "./OfferList.js";
import { ActiveTaskPanel } from "./ActiveTaskPanel.js";
import { HelperNotice } from "./HelperNotice.js";

/**
 * ── The helper's app (audit C2: "helper-side UI" — there was none) ────────────
 *
 * Why this matters beyond filling a gap: without a helper client, NOTHING in the system could
 * exercise the half of the protocol that actually produces a match. `publish-availability` had
 * no caller, `offer`/`offer-closed` had no listener, `accept` was never raced from a browser,
 * and the helper-driven lifecycle edges (`en-route`, `arrived`, `in-progress`) could only be
 * reached by a requester client pretending to be a helper — which is precisely how the A6 ETA
 * bug and the `ME = "me"` (B13) bug stayed invisible.
 *
 * The screen is deliberately one column with one decision at a time, the same discipline as the
 * requester side: a helper reads this while walking.
 */
export function HelperShell() {
  const { connection, task, offers } = useHelperExperience();

  // The switch is intentionally coarse — a helper is either working or looking for work. Any
  // finer state (which offer is focused, etc.) belongs inside the panels.
  const mode = task ? "task" : "idle";

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", padding: "16px 16px 40px" }}>
      <ConnectionBanner connection={connection} />
      <HelperNotice />

      <AnimatePresence mode="wait">
        <motion.div
          key={mode}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
        >
          {mode === "task" ? (
            <ActiveTaskPanel />
          ) : (
            <>
              <AvailabilityPanel />
              {/* Offers sit BELOW the availability control on purpose: the toggle is the thing
                  a helper looks for when nothing is happening, and an offer arriving must not
                  shift it out from under their thumb. */}
              <OfferList />
              {offers.length === 0 && <IdleHint />}
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** Says what is happening while nothing is happening. An empty screen reads as "broken",
 *  and a helper who thinks the app is broken stops opening it. */
function IdleHint() {
  const { available } = useHelperExperience();
  return (
    <p
      style={{
        textAlign: "center",
        fontSize: 14,
        lineHeight: 1.5,
        color: "var(--needy-text-soft)",
        margin: "22px 6px 0",
      }}
    >
      {available
        ? "You're on the list. We'll only send you requests close by, and you can pass on any of them."
        : "You're not receiving requests right now. Turn on availability when you have time to help."}
    </p>
  );
}
