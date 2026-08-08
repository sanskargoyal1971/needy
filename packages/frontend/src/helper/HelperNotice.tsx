import { AnimatePresence, motion } from "framer-motion";
import type { SocketErrorPayload } from "@needy/shared";
import { useHelperExperience } from "../realtime/index.js";

/**
 * Shows the most recent server refusal in words a person can act on.
 *
 * This is the client half of audit A3's requirement that the server "reject with a clear error
 * event, don't silently drop". A rejection nobody renders is the same as a drop from the user's
 * side — worse, actually, because the developer believes it is handled. The specific failures
 * this catches for a helper:
 *
 *  - `NOT_AUTHORIZED` on `publish-availability`: the account isn't KYC-verified, so matching's
 *    hard filter (B11) will never consider it. Without this message the availability toggle
 *    sits on and no request ever arrives, forever, with no explanation.
 *  - `NOT_AUTHORIZED` on `location`: position is being refused because the task isn't in a
 *    trackable state. The symptom is a requester whose map never moves.
 *  - `RATE_LIMITED`: updates are being shed (C20).
 *  - `NOT_A_PARTICIPANT` / `NOT_TASK_HELPER` on chat or tracking: a stale task id after a
 *    reassignment.
 *
 * Codes are never shown. `message` from the server is for logs — it is deliberately NOT
 * rendered — so this maps `code` to prose, with a generic fallback that still tells the user
 * what to do. That mirrors `humanize()` in LoginScreen for the same reason: for this audience an
 * error must say what to do next, never what went wrong internally.
 */
const COPY: Record<SocketErrorPayload["code"], string> = {
  AUTH_REQUIRED: "Please sign in again to keep helping.",
  INVALID_PAYLOAD: "Something didn't send correctly. Please try that again.",
  NOT_A_PARTICIPANT: "This request isn't yours any more. It may have gone to someone else.",
  NOT_TASK_HELPER: "You're not the helper on this request any more.",
  NOT_AUTHORIZED: "You can't do that just yet.",
  RATE_LIMITED: "That's happening a bit too fast — give it a moment.",
  NOT_FOUND: "We couldn't find that request. It may have been cancelled.",
  INTERNAL: "Something went wrong on our side. Please try again in a moment.",
};

/** A few refusals have a much more useful, specific explanation than their code alone. Keyed by
 *  event so the same code can read differently where the consequence differs. */
function explain(err: SocketErrorPayload): string {
  if (err.code === "NOT_AUTHORIZED" && err.event === "publish-availability") {
    return "Your ID check isn't complete yet, so we can't send you requests. Finish verifying and you'll start receiving them.";
  }
  if (err.code === "NOT_AUTHORIZED" && err.event === "location") {
    return "We're not sharing your location right now. Tap \"I've set off\" when you start travelling.";
  }
  if (err.event === "snapshot") {
    return "We couldn't check in with the server. If you're on a task, keep going — we'll catch up.";
  }
  return COPY[err.code];
}

export function HelperNotice() {
  const { lastError } = useHelperExperience();
  return (
    <AnimatePresence>
      {lastError && (
        <motion.div
          // Re-keyed per event+code so a NEW refusal visibly replaces an old one instead of
          // sitting there looking like the same stale message.
          key={`${lastError.event}:${lastError.code}`}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.3 }}
          // `alert` rather than `status`: these are refusals of something the helper just
          // asked for, so a screen reader should interrupt rather than wait its turn.
          role="alert"
          style={{
            fontSize: 14,
            lineHeight: 1.45,
            fontWeight: 600,
            color: "var(--needy-text)",
            background: "rgba(232,147,90,.14)",
            border: "1px solid rgba(232,147,90,.32)",
            borderRadius: 14,
            padding: "10px 14px",
            marginBottom: 12,
          }}
        >
          {explain(lastError)}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
