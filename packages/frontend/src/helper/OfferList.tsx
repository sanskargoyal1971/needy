import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { MatchOffer, TaskCategory } from "@needy/shared";
import { spring } from "../motion/index.js";
import { useHelperDriver, useHelperExperience } from "../realtime/index.js";
import { formatDistance } from "./format.js";

/**
 * Live offers, each with the time left to take it.
 *
 * The server broadcasts one request to EVERY eligible helper at once and settles the race with a
 * distributed lock (§2.4), so several helpers are looking at this same card and only one will win.
 * Two consequences the UI has to be honest about:
 *
 *  1. Losing is normal. `accept` acks `{won: false, reason: "already-taken"}` and that is not an
 *     error — the copy in {@link ClosedNotice} says someone else got there, not that anything
 *     failed.
 *  2. The window is real and server-enforced. `expiresAt` came from the server, was previously
 *     never checked anywhere, and is now enforced inside the lock. A card that has lapsed can no
 *     longer be accepted, so it must stop inviting a tap — hence the live countdown and the
 *     driver's own expiry timer.
 */
export function OfferList() {
  const { offers, lastClosed } = useHelperExperience();

  return (
    <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
      <ClosedNotice closed={lastClosed} />
      <AnimatePresence initial={false}>
        {offers.map((offer) => (
          <motion.div
            key={offer.taskId}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.2 } }}
            transition={spring.greet}
          >
            <OfferCard offer={offer} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Human framing per category. A helper deciding in a few seconds needs to know what KIND of
 *  thing this is before they read the title — "someone needs company" and "someone needs
 *  medicine now" call for different people. */
const CATEGORY: Record<TaskCategory, { label: string; hint: string }> = {
  errand: { label: "An errand", hint: "Picking something up or dropping it off" },
  companionship: { label: "Company", hint: "Someone would like company for a while" },
  "social-service": { label: "Community help", hint: "A volunteer request in your area" },
  urgent: { label: "Urgent", hint: "Someone needs help soon" },
};

function OfferCard({ offer }: { offer: MatchOffer }) {
  const driver = useHelperDriver();
  const secondsLeft = useCountdown(offer.expiresAt);
  const category = CATEGORY[offer.category];
  // Guard the tap rather than only hiding the card: the driver removes a lapsed offer on its own
  // timer, but a tap that lands in the same frame as expiry would otherwise emit an accept the
  // server is guaranteed to refuse.
  const lapsed = secondsLeft <= 0;

  return (
    <article
      style={{
        background: "var(--needy-surface)",
        border: `1px solid ${offer.category === "urgent" ? "rgba(229,72,77,.4)" : "var(--needy-border)"}`,
        borderRadius: 18,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: 0.3,
            textTransform: "uppercase",
            color: offer.category === "urgent" ? "var(--needy-alarm)" : "var(--needy-text-soft)",
          }}
        >
          {category.label}
        </span>
        <Countdown secondsLeft={secondsLeft} />
      </header>

      <div>
        <div style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.3 }}>{offer.title}</div>
        <div style={{ fontSize: 13.5, color: "var(--needy-text-soft)", marginTop: 4 }}>
          {formatDistance(offer.distanceMeters)} away · {category.hint}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={() => driver.accept(offer.taskId)}
          disabled={lapsed}
          style={{
            flex: 2,
            // 52px: the same floor the login screen uses. This is tapped in a hurry.
            minHeight: 52,
            border: "none",
            borderRadius: 14,
            background: "var(--needy-warm)",
            color: "#fff",
            fontSize: 16,
            fontWeight: 800,
            cursor: lapsed ? "not-allowed" : "pointer",
            opacity: lapsed ? 0.5 : 1,
          }}
        >
          {lapsed ? "Too late" : "I can help"}
        </button>
        <button
          onClick={() => driver.decline(offer.taskId)}
          style={{
            flex: 1,
            minHeight: 52,
            border: "1px solid var(--needy-border)",
            borderRadius: 14,
            background: "transparent",
            color: "var(--needy-text-soft)",
            fontSize: 15,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Pass
        </button>
      </div>
    </article>
  );
}

/** The remaining window. Turns warm under 15s rather than red: this is a deadline, not an
 *  emergency, and the alarm colour is reserved exclusively for SOS. */
function Countdown({ secondsLeft }: { secondsLeft: number }) {
  const urgent = secondsLeft <= 15;
  return (
    <span
      // Not `aria-live`: a per-second announcement would make a screen reader unusable. The
      // remaining time is available on demand via the label instead.
      aria-label={`${Math.max(0, secondsLeft)} seconds left to accept`}
      style={{
        fontSize: 13,
        fontWeight: 800,
        color: urgent ? "var(--needy-warm)" : "var(--needy-text-soft)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {Math.max(0, secondsLeft)}s
    </span>
  );
}

/** Seconds until `expiresAt`, ticking once a second. Derived from the SERVER's timestamp, so a
 *  client with a skewed clock is the one visible cost — deliberately preferred over trusting a
 *  locally-computed window, since the server is what actually enforces expiry. */
function useCountdown(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.ceil((expiresAt - now) / 1000);
}

/** Why an offer left the screen. Without this a card vanishes under the helper's thumb and they
 *  are left wondering whether they tapped it and something broke. */
function ClosedNotice({
  closed,
}: {
  closed: { taskId: string; reason: "already-taken" | "expired" | "cancelled" } | null;
}) {
  if (!closed) return null;
  const text =
    closed.reason === "already-taken"
      ? "Another helper got there first — thanks for being quick."
      : closed.reason === "cancelled"
        ? "That request was cancelled."
        : "That request timed out.";
  return (
    <p
      role="status"
      style={{
        margin: 0,
        fontSize: 13.5,
        fontWeight: 600,
        color: "var(--needy-text-soft)",
        background: "var(--needy-surface-2)",
        border: "1px solid var(--needy-border)",
        borderRadius: 12,
        padding: "9px 14px",
        textAlign: "center",
      }}
    >
      {text}
    </p>
  );
}
