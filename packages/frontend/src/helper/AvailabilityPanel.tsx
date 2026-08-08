import { motion } from "framer-motion";
import { BreathingPulse, spring } from "../motion/index.js";
import { useHelperExperience, useHelperDriver } from "../realtime/index.js";
import { useGeolocation } from "./useGeolocation.js";

/**
 * The helper's one control that matters: am I available right now?
 *
 * This is the client end of audit A1. The server's availability geo index — the thing matching's
 * GEOSEARCH reads to find candidates — is written by exactly one event, `/presence`'s
 * `publish-availability`, and nothing in the app ever emitted it. So the index was empty for
 * every real helper, every search found zero candidates, and the only writer was the task-bound
 * `/tracking` `location` event, which requires already being matched. That circularity was the
 * discovery deadlock: to become findable you first had to be found.
 *
 * A toggle needs a POSITION to publish, so the geolocation permission prompt is deliberately
 * tied to this switch rather than fired on page load: asking for someone's location before they
 * have said they want to help is both worse for consent and much more likely to be denied.
 */
export function AvailabilityPanel() {
  const { available, position, connection } = useHelperExperience();
  const driver = useHelperDriver();
  const geo = useGeolocation({
    // Only watch the device position while we are actually advertising or on a task — a
    // continuous GPS watch is the single most expensive thing this app can do to a phone
    // battery, and holding one open while the helper isn't available buys nothing.
    enabled: available,
    onPosition: (point, extras) => driver.reportPosition(point, extras),
  });

  // Being connected is a precondition for publishing anything: a toggle that flips on while the
  // socket is down would show "Available" while the server has never heard of us.
  const canGoAvailable = connection === "online" || connection === "resyncing";

  const toggle = () => {
    if (!available && !canGoAvailable) return;
    driver.setAvailable(!available);
  };

  return (
    <section
      style={{
        background: "var(--needy-surface)",
        border: "1px solid var(--needy-border)",
        borderRadius: 20,
        padding: 20,
        display: "grid",
        gap: 14,
        placeItems: "center",
        textAlign: "center",
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>
        {available ? "You're available to help" : "Ready to help someone?"}
      </h2>

      {/* The breathing pulse is the same primitive the requester's search uses, in presence
          green: it reads as "a living thing is listening", which is exactly the state. */}
      <BreathingPulse size={132} color="presence" intensity={available ? "base" : "subtle"}>
        <motion.button
          onClick={toggle}
          whileTap={{ scale: 0.95 }}
          transition={spring.greet}
          disabled={!available && !canGoAvailable}
          aria-pressed={available}
          style={{
            // 116px, far past the 44px minimum: this is the primary control on the screen and
            // it gets pressed one-handed, outdoors, often in a hurry.
            width: 116,
            height: 116,
            borderRadius: "50%",
            border: available ? "none" : "2px solid var(--needy-border)",
            background: available ? "var(--needy-presence)" : "var(--needy-surface)",
            color: available ? "#fff" : "var(--needy-text)",
            fontSize: 15,
            fontWeight: 800,
            lineHeight: 1.25,
            cursor: !available && !canGoAvailable ? "not-allowed" : "pointer",
            opacity: !available && !canGoAvailable ? 0.5 : 1,
            padding: 8,
          }}
        >
          {available ? "Available" : "Go available"}
        </motion.button>
      </BreathingPulse>

      <StatusLine
        available={available}
        canGoAvailable={canGoAvailable}
        hasPosition={position != null}
        geoError={geo.error}
      />
    </section>
  );
}

/**
 * One line, one fact, phrased as what the helper can do about it.
 *
 * The location cases are the important ones. A denied permission is not an error the helper can
 * ignore — without a position there is nothing to publish, so they will never receive a request
 * — but it is also not the app's fault, so the copy points at the browser's own control rather
 * than blaming either side.
 */
function StatusLine({
  available,
  canGoAvailable,
  hasPosition,
  geoError,
}: {
  available: boolean;
  canGoAvailable: boolean;
  hasPosition: boolean;
  geoError: string | null;
}) {
  let text: string;
  if (geoError) text = geoError;
  else if (!available && !canGoAvailable)
    text = "Waiting to reach the server — you'll be able to go available in a moment.";
  else if (available && !hasPosition) text = "Finding your location so we can send you nearby requests…";
  else if (available) text = "We'll send you requests close to you. Nobody sees your exact position.";
  else text = "You choose when to be available, and you can pass on any request.";

  return (
    <p
      // `status`, not `alert`: this narrates the current situation rather than interrupting.
      role="status"
      style={{
        margin: 0,
        fontSize: 13.5,
        lineHeight: 1.5,
        color: "var(--needy-text-soft)",
        maxWidth: 300,
      }}
    >
      {text}
    </p>
  );
}
