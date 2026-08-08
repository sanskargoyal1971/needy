import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { canActorTransition, canTransition, isTerminal } from "@needy/shared";
import { spring } from "../motion/index.js";
import { useReducedMotionPref } from "../motion/preferences.js";
import { useDriver, useTaskExperience } from "../realtime/index.js";

/**
 * ── Cancelling a request ────────────────────────────────────────────────────
 *
 * There was no way for a requester to cancel. The `cancelled` state rendered a single line of
 * text ("This request was cancelled.") with no path back to anything, and nothing in the UI could
 * ever produce that state — only the demo harness's "simulate helper" debug bar could. So a
 * requester who no longer needed help, or who wanted out of a live tracking session with a
 * stranger, had no control at all. That is the same class of gap as the SOS button: the product
 * implied an ability it did not have.
 *
 * The edge itself was always legal and always authorized — `TASK_TRANSITIONS` allows
 * `cancelled` from every non-terminal state and `TRANSITION_ACTORS` grants it to
 * `["requester", "helper"]` precisely so nobody is trapped in a live session. Both are imported
 * here rather than restated, so this control can never offer an action the server will refuse.
 *
 * NO REASON FIELD, deliberately. `advance-task` carries `{ taskId, to }` and nothing else, and
 * there is no column to persist a reason into. A textarea whose contents were dropped on submit
 * would be exactly the defect this pass exists to remove — UI that promises something the app
 * does not do. Capturing a reason is a coherent feature, but it needs the shared payload, the
 * handler and a migration first.
 */
export function CancelRequestControl() {
  const { task, userId } = useTaskExperience();
  const driver = useDriver();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const reduced = useReducedMotionPref();

  if (!task || isTerminal(task.state)) return null;

  // Gate on the SAME two predicates the server enforces. A control that appears when the
  // server would refuse it is how a UI starts lying about what it can do.
  const role = task.requesterId === userId ? "requester" : "helper";
  if (!canTransition(task.state, "cancelled") || !canActorTransition(role, "cancelled")) {
    return null;
  }

  const matched = task.helperId != null;

  return (
    <>
      <div style={{ display: "grid", placeItems: "center", marginTop: 18 }}>
        <button
          onClick={() => setOpen(true)}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--needy-text-soft)",
            fontSize: 16,
            fontWeight: 600,
            textDecoration: "underline",
            // Understated on purpose: this sits on screen for the whole task and must never
            // compete with the SOS control or be reachable by a stray thumb.
            padding: "10px 14px",
            minHeight: 44,
            cursor: "pointer",
          }}
        >
          Cancel this request
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.2 }}
            role="dialog"
            aria-modal="true"
            aria-label="Cancel this request"
            onClick={() => !busy && setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,.45)",
              display: "grid",
              alignItems: "end",
              zIndex: 40,
            }}
          >
            <motion.div
              initial={reduced ? false : { y: 40 }}
              animate={{ y: 0 }}
              exit={reduced ? { opacity: 0 } : { y: 40 }}
              transition={reduced ? { duration: 0 } : spring.greet}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "var(--needy-surface)",
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                borderTop: "1px solid var(--needy-border)",
                padding: "22px 18px calc(28px + env(safe-area-inset-bottom, 0px))",
                display: "grid",
                gap: 12,
                maxWidth: 420,
                width: "100%",
                margin: "0 auto",
              }}
            >
              <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800 }}>
                Cancel this request?
              </h2>
              <p style={{ margin: 0, fontSize: 16, lineHeight: 1.55, color: "var(--needy-text-soft)" }}>
                {matched
                  ? "We'll let your helper know straight away so they stop travelling to you. You can always ask for help again afterwards."
                  : "We'll stop looking for a helper. You can always ask for help again afterwards."}
              </p>

              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  // Fire and let the authoritative `task-updated` broadcast move the UI — the
                  // same rule the rest of the app follows. The sheet stays up until the server
                  // agrees, so a refused cancel cannot leave the screen claiming it worked.
                  driver.advanceTo("cancelled");
                }}
                style={{
                  minHeight: 56,
                  border: "none",
                  borderRadius: 14,
                  background: "var(--needy-alarm)",
                  color: "#fff",
                  fontSize: 17,
                  fontWeight: 800,
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                {busy ? "Cancelling…" : "Yes, cancel it"}
              </button>
              <button
                disabled={busy}
                onClick={() => setOpen(false)}
                style={{
                  minHeight: 52,
                  border: "1px solid var(--needy-border)",
                  borderRadius: 14,
                  background: "transparent",
                  color: "var(--needy-text)",
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                No, keep it
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
