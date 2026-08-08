import { AnimatePresence, motion } from "framer-motion";
import { useTaskExperience } from "../realtime/index.js";
import { LiveMap } from "./LiveMap.js";
import { formatEta } from "./shared.js";

/**
 * Stage 4 — Helper en route (§3). A real map (Leaflet/OSM via {@link LiveMap}) on which the
 * helper is a human silhouette that faces its travel direction and GLIDES between GPS points,
 * never teleporting — this is where "feels alive" is won technically. The ETA ticks smoothly
 * and warm milestones surface as the helper progresses, so it's never silence-until-arrival.
 */
export function EnRouteStage() {
  const { task, location, eta, milestones, helper } = useTaskExperience();
  const origin = task?.origin ?? null;
  const latestMilestone = milestones[milestones.length - 1];
  const helperName = helper?.displayName ?? "Your helper";

  return (
    <div style={{ display: "grid", placeItems: "center", gap: 16, padding: "8px 0" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        {origin ? (
          <LiveMap
            origin={origin}
            helper={location ? { lat: location.lat, lng: location.lng } : null}
            heading={location?.heading ?? 0}
            durationMs={4000}
            height={260}
          />
        ) : (
          // We have no destination to draw yet (the task hasn't resynced, or it arrived
          // without an origin). This used to default to { lat: 0, lng: 0 } — Null Island —
          // so the user was shown an empty stretch of the Atlantic labelled as their own
          // street, which for this audience is worse than showing no map at all. Say plainly
          // that the map isn't available; the ETA and milestones below still work.
          <LocationUnavailable helperName={helperName} />
        )}
      </div>

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 22, fontWeight: 800 }}>
          {eta ? formatEta(eta.etaSeconds) : "finding the fastest way to you"}
        </div>
        <div style={{ fontSize: 14, color: "var(--needy-text-soft)", marginTop: 2 }}>
          {helperName} is on the way
        </div>
      </div>

      <div style={{ minHeight: 28 }}>
        <AnimatePresence mode="wait">
          {latestMilestone && (
            <motion.div
              key={latestMilestone}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.4 }}
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--needy-warm)",
                background: "rgba(232,147,90,.12)",
                borderRadius: 999,
                padding: "5px 14px",
              }}
            >
              {latestMilestone}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** The honest stand-in for the map when we have no origin to centre it on. Same rounded
 *  surface and height as {@link LiveMap} so the stage doesn't jump if the origin arrives a
 *  moment later, and worded as a temporary, non-alarming gap — the helper is still coming. */
function LocationUnavailable({ helperName }: { helperName: string }) {
  return (
    <div
      role="status"
      style={{
        height: 260,
        borderRadius: 18,
        border: "1px dashed var(--needy-border)",
        background: "var(--needy-surface-2)",
        display: "grid",
        placeItems: "center",
        textAlign: "center",
        padding: 24,
        gap: 6,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700 }}>The map isn't available just now</div>
      <div style={{ fontSize: 13, color: "var(--needy-text-soft)", lineHeight: 1.5, maxWidth: 260 }}>
        We can't show {helperName}'s position on a map at the moment, but they're still on
        their way — you'll see the time below update as they get closer.
      </div>
    </div>
  );
}
